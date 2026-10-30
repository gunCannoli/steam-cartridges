// app/ingest: the background job that fetches data for shortcuts (migration plan M7b; replaces
// features/scraper/sync-manager.ts). User decision 2: at start-up only **new** shortcuts are fetched;
// everything else refreshes when its page is opened and its data is stale (the backend's TTLs decide,
// `fresh_policy.lua`). "Sync now" from the settings panel walks every shortcut (with `force` for a full
// refresh), and the backend never refreshes a manual edit.
//
// It writes nothing to records: the backend persists what it fetches, and a record picks it up on the
// shortcut's next view. (Writing records for every shortcut at start-up makes every record-driven surface
// render for all of them at once; see knowledgebase Part 7.)
import { logger } from "../logger.ts";
import type { ShortcutId } from "../kernel/appid";
import type { Identity, OwnedCandidate, Part, Route, SyncProgress } from "../kernel/record";
import type { backend as Backend } from "../ports/backend";
import { asList } from "../kernel/lists.ts";

export interface IngestDeps {
    backend: Pick<typeof Backend, "getNewShortcuts" | "markKnown" | "ensureFresh" | "getSetupState">;
    /** Every shortcut in the library (the full-sync source). */
    shortcuts(): { appid: number; name: string }[];
    /** Routing inputs are loaded (auto-routing profiles, collections). */
    ready(): Promise<void>;
    routeOf(appid: ShortcutId): Route;
    /** Routing rules and Auto Mode allow the plugin to touch this shortcut at all. */
    isAllowed(appid: ShortcutId): boolean;
    owned(): OwnedCandidate[];
    allowWeb(appid: ShortcutId): boolean;
    allowScreenscraper(appid: ShortcutId): boolean;
    hardcore(): boolean;
    /** Polite pause between shortcuts (300 ms). */
    sleep(ms: number): Promise<void>;
    /** Re-run a start-up sync that was requested while one was running (tests pass a no-op). */
    schedule?(fn: () => void, ms: number): void;
    /** Check if an existing shortcut is missing achievements or metadata. */
    needsFetch?(appid: ShortcutId): boolean;
    /** One line per sync in the plugin log users share (ClientLog): why it started, what it walked, when it is done. */
    report?: (message: string) => void;
    /** Called when a shortcut has been successfully fetched. */
    onDone?(appid: ShortcutId): void;
    /** Artwork resolver: writes cover-arts and icon to Steam native components when data is fetched. */
    artwork?: {
        ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined, opts?: { lane?: "background" | "normal" }): Promise<unknown>;
    };
}

export interface Ingest {
    /** `reason` names the trigger in the log (startup, rules, services, confirmed, fetch-now): the first thing a "why is it fetching" report needs. */
    startSync(options?: { forceAll?: boolean; onlyAppids?: number[]; reason?: string }): Promise<void>;
    /** Debounced startSync(): queued whenever settings or rules change. */
    triggerSync(delayMs?: number, reason?: string): void;
    getSyncProgress(): SyncProgress;
    onSyncProgress(fn: (p: SyncProgress) => void): () => void;
}

/** Polite pause between individual shortcuts (today's value). */
const PAUSE_MS = 300;

/** Every ingest call waits behind what the user is looking at (ADR-0060). */
const BACKGROUND = { lane: "background" } as const;

/** Sources whose pause should stop a run (sgdb is not used here). */
const RELEVANT_SOURCES = ["steam-store", "igdb", "screenscraper", "steam-web", "retroachievements"];

function pausedIn(res: { paused?: Record<string, number> } | undefined): boolean {
    return !!res?.paused && RELEVANT_SOURCES.some((s) => s in (res.paused as Record<string, number>));
}

export function createIngest(deps: IngestDeps): Ingest {
    let progress: SyncProgress = { isSyncing: false, total: 0, current: 0, currentGame: "", phase: "idle", failed: 0 };
    const listeners = new Set<(p: SyncProgress) => void>();
    let running = false;
    /** Runs requested while one was running, merged into one follow-up (scope is kept, not dropped). */
    let pending: { forceAll: boolean; only: Set<number> | null; waiters: (() => void)[]; reason: string } | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    function setProgress(update: Partial<SyncProgress>): void {
        progress = { ...progress, ...update };
        for (const l of listeners) {
            try {
                l(progress);
            } catch (e) {
                logger.warn("SyncProgress listener threw:", e);
            }
        }
    }

    /** One shortcut. `stop` = a source is paused: end the run and leave this one for later. `errors` names the
     *  parts that failed, so the run reports them to the plugin log instead of swallowing them (logger.warn is
     *  stripped from prod builds). */
    async function ingestOne(item: { appid: number; name: string }, force: boolean): Promise<{ stop: boolean; done: boolean; errors: string[] }> {
        const appid = item.appid as ShortcutId;
        const route = deps.routeOf(appid);
        if (route.via === "pending") return { stop: false, done: false, errors: [] }; // collections not ready: try next run
        if (route.bucket === "none") {
            deps.report?.(`sync skip "${item.name}" (bucket none)`);
            return { stop: false, done: true, errors: [] }; // ADR-0035: no network for it
        }

        const base = {
            title: item.name,
            route,
            owned: deps.owned(),
            allowWeb: deps.allowWeb(appid),
            allowScreenscraper: deps.allowScreenscraper(appid),
            hardcore: deps.hardcore(),
            force,
        };

        let identity: Part<Identity> | undefined;
        const errors: string[] = [];
        // What each part answered (ok | empty | unsupported | error | skipped ...), for the one [sync] line per game: a part that
        // answers "nothing" is not an error, so without this a Linux report of "nothing fetched" has no evidence.
        const seen: string[] = [];
        const note = (part: string, res: { parts?: Record<string, { status?: string; source?: string }> }) => {
            const p = res?.parts?.[part];
            seen.push(`${part}=${p?.status ?? "none"}${p?.source ? `(${p.source})` : ""}`);
        };
        const noteError = (part: string, res: { parts?: Record<string, { status?: string; message?: string }> }) => {
            const p = res?.parts?.[part];
            if (p?.status === "error" && p?.message) errors.push(`${part}: ${p.message}`);
        };
        if (route.bucket === "steam-store") {
            const res = await deps.backend.ensureFresh(appid, ["identity"], base, BACKGROUND);
            if (pausedIn(res)) return { stop: true, done: false, errors };
            identity = res.parts?.identity as Part<Identity> | undefined;
            noteError("identity", res as never);
            note("identity", res as never);
        }

        // A Steam match's own metadata is read from Steam when its page is opened (never persisted), so
        // only a shortcut without one needs the IGDB / ScreenScraper tier. One part per call: the Lua host
        // serves one call at a time, so shorter calls let a page's call in between (ADR-0060).
        const native = identity?.data?.native;
        const parts: ("metadata" | "achievements")[] = native ? ["achievements"] : ["metadata", "achievements"];
        for (const part of parts) {
            const res = await deps.backend.ensureFresh(appid, [part], { ...base, identity }, BACKGROUND);
            if (pausedIn(res)) return { stop: true, done: false, errors };
            noteError(part, res as never);
            note(part, res as never);
        }
        if (deps.artwork) {
            try {
                await deps.artwork.ensure(appid, route, identity, BACKGROUND);
            } catch (e) {
                errors.push(`artwork: ${String((e as Error)?.message ?? e)}`);
            }
        }
        if (errors.length === 0) {
            deps.report?.(
                `sync game "${item.name}": bucket=${route.bucket}, web=${base.allowWeb ? "on" : "off"}, screenscraper=${base.allowScreenscraper ? "on" : "off"}, ${seen.join(", ") || "no parts"}`,
            );
        }
        return { stop: false, done: true, errors };
    }

    async function startSync(options?: { forceAll?: boolean; onlyAppids?: number[]; reason?: string }): Promise<void> {
        const reason = options?.reason ?? "sync";
        if (running) {
            const only = options?.onlyAppids ? new Set(options.onlyAppids) : null;
            if (!pending) pending = { forceAll: options?.forceAll === true, only, waiters: [], reason };
            else {
                pending.forceAll ||= options?.forceAll === true;
                pending.only = pending.only && only ? new Set([...pending.only, ...only]) : null;
                pending.reason = reason;
            }
            // A per-game scan (audit panel) resolves when its follow-up run ends; plain requests are debounced re-runs.
            if (!only) return;
            return new Promise<void>((resolve) => pending!.waiters.push(resolve));
        }
        running = true;
        const force = options?.forceAll === true;
        try {
            await deps.ready();

            // Library Setup (ADR-0086): until the user has run it nothing is fetched, and no game is marked known (it
            // would drop out of the "new games" count unfetched). An answer we cannot read is no gate (fail open).
            const setup = await deps.backend.getSetupState(BACKGROUND).catch(() => undefined);
            // A run over the whole library also waits for onboarding (finished or skipped), even for an install that held data
            // before Library Setup existed; a per-game run (the setup window, the audit panel) only needs the consent.
            if (setup?.done === false || (setup?.onboarded === false && !options?.onlyAppids)) {
                logger.info("Ingest: Library Setup has not run yet; nothing is fetched.");
                deps.report?.(`sync skip (${reason}): setup not run`);
                setProgress({ isSyncing: false, phase: "idle", total: 0, current: 0, failed: 0 });
                return;
            }

            let items: { appid: number; name: string }[];
            let newCount = 0,
                missingCount = 0;
            if (force || options?.onlyAppids) {
                const only = options?.onlyAppids ? new Set(options.onlyAppids) : null;
                items = deps.shortcuts().filter((s) => (!only || only.has(s.appid)) && deps.isAllowed(s.appid as ShortcutId));
            } else {
                const res = await deps.backend.getNewShortcuts(BACKGROUND);
                const newItems = asList<{ appid: number; name: string }>(res?.shortcuts).filter(
                    (s) => s && typeof s.appid === "number" && deps.isAllowed(s.appid as ShortcutId),
                );
                const newIds = new Set(newItems.map((i) => i.appid));
                const missingItems = deps.needsFetch
                    ? deps.shortcuts().filter(
                          (s) =>
                              !newIds.has(s.appid) &&
                              deps.isAllowed(s.appid as ShortcutId) &&
                              deps.needsFetch!(s.appid as ShortcutId),
                      )
                    : [];
                newCount = newItems.length;
                missingCount = missingItems.length;
                items = [...newItems, ...missingItems];
            }

            if (items.length === 0) {
                setProgress({ isSyncing: false, phase: "idle", total: 0, current: 0, failed: 0 });
                deps.report?.(`sync idle (${reason}): nothing to walk`);
                return;
            }

            logger.info(`Ingest: ${items.length} shortcut(s)${force ? " (forced)" : ""}...`);
            deps.report?.(
                force || options?.onlyAppids
                    ? `sync start (${reason}, forced): ${items.length} games`
                    : `sync start (${reason}): ${items.length} to walk (${newCount} new, ${missingCount} missing)`,
            );
            setProgress({ isSyncing: true, total: items.length, current: 0, currentGame: items[0]?.name ?? "", phase: "scraping", failed: 0 });

            let walked = 0;
            let failed = 0;
            for (const [i, item] of items.entries()) {
                walked++;
                setProgress({ current: i + 1, currentGame: item.name, failed });
                let outcome = { stop: false, done: false, errors: [] as string[] };
                try {
                    outcome = await ingestOne(item, force);
                } catch (e) {
                    outcome = { stop: false, done: false, errors: [String((e as Error)?.message ?? e)] };
                }
                if (outcome.errors.length > 0) {
                    failed++;
                    setProgress({ failed });
                    deps.report?.(`sync game "${item.name}": ${outcome.errors.join("; ")}`);
                }
                if (outcome.stop) {
                    deps.report?.(`sync paused (${reason}): a source is rate-limited; stops at ${item.name}, resumes next run`);
                    logger.warn("A source is paused (rate limit or repeated errors); ingest stops and resumes next run.");
                    break;
                }
                if (outcome.done) {
                    deps.onDone?.(item.appid as ShortcutId);
                    await deps.backend.markKnown([item.appid], BACKGROUND).catch(() => undefined);
                }

                await deps.sleep(PAUSE_MS);
            }

            setProgress({ isSyncing: false, phase: "complete", failed });
            deps.report?.(`sync done (${reason}): walked ${walked} of ${items.length}${failed > 0 ? `, ${failed} failed` : ""}`);
            // Back to idle after a few seconds.
            const idle = setTimeout(() => {
                if (!running) setProgress({ phase: "idle" });
            }, 5000) as unknown as { unref?: () => void };
            idle.unref?.(); // never hold a Node test process open
        } catch (e) {
            logger.error("Ingest failed:", e);
            deps.report?.(`sync error (${reason}): ${String((e as Error)?.message ?? e)}`);
            setProgress({ isSyncing: false, phase: "idle", failed: 0 });
        } finally {
            running = false;
            if (pending) {
                const next = pending;
                pending = null;
                const again = { forceAll: next.forceAll, onlyAppids: next.only ? [...next.only] : undefined, reason: next.reason };
                (deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms)))(() => void startSync(again).finally(() => next.waiters.forEach((w) => w())), 1000);
            }
        }
    }

    return {
        startSync,
        triggerSync(delayMs = 500, reason = "sync") {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                debounce = null;
                void startSync({ reason });
            }, delayMs);
        },
        getSyncProgress: () => progress,
        onSyncProgress(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
