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
    backend: Pick<typeof Backend, "getNewShortcuts" | "markKnown" | "ensureFresh">;
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
    /** Called when a shortcut has been successfully fetched. */
    onDone?(appid: ShortcutId): void;
    /** Artwork resolver: writes cover-arts and icon to Steam native components when data is fetched. */
    artwork?: {
        ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined, opts?: { lane?: "background" | "normal" }): Promise<unknown>;
    };
}

export interface Ingest {
    startSync(options?: { forceAll?: boolean; onlyAppids?: number[] }): Promise<void>;
    /** Debounced startSync(): queued whenever settings or rules change. */
    triggerSync(delayMs?: number): void;
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
    let progress: SyncProgress = { isSyncing: false, total: 0, current: 0, currentGame: "", phase: "idle" };
    const listeners = new Set<(p: SyncProgress) => void>();
    let running = false;
    /** Runs requested while one was running, merged into one follow-up (scope is kept, not dropped). */
    let pending: { forceAll: boolean; only: Set<number> | null; waiters: (() => void)[] } | null = null;
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

    /** One shortcut. `stop` = a source is paused: end the run and leave this one for later. */
    async function ingestOne(item: { appid: number; name: string }, force: boolean): Promise<{ stop: boolean; done: boolean }> {
        const appid = item.appid as ShortcutId;
        const route = deps.routeOf(appid);
        if (route.via === "pending") return { stop: false, done: false }; // collections not ready: try next run
        if (route.bucket === "none") return { stop: false, done: true }; // ADR-0035: no network for it

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
        if (route.bucket === "steam-store") {
            const res = await deps.backend.ensureFresh(appid, ["identity"], base, BACKGROUND);
            if (pausedIn(res)) return { stop: true, done: false };
            identity = res.parts?.identity as Part<Identity> | undefined;
        }

        // A Steam match's own metadata is read from Steam when its page is opened (never persisted), so
        // only a shortcut without one needs the IGDB / ScreenScraper tier. One part per call: the Lua host
        // serves one call at a time, so shorter calls let a page's call in between (ADR-0060).
        const native = identity?.data?.native;
        const parts: ("metadata" | "achievements")[] = native ? ["achievements"] : ["metadata", "achievements"];
        for (const part of parts) {
            const res = await deps.backend.ensureFresh(appid, [part], { ...base, identity }, BACKGROUND);
            if (pausedIn(res)) return { stop: true, done: false };
        }
        if (deps.artwork) {
            try {
                await deps.artwork.ensure(appid, route, identity, BACKGROUND);
            } catch (e) {
                logger.warn(`Ingest artwork failed for ${appid}:`, e);
            }
        }
        return { stop: false, done: true };
    }

    async function startSync(options?: { forceAll?: boolean; onlyAppids?: number[] }): Promise<void> {
        if (running) {
            const only = options?.onlyAppids ? new Set(options.onlyAppids) : null;
            if (!pending) pending = { forceAll: options?.forceAll === true, only, waiters: [] };
            else {
                pending.forceAll ||= options?.forceAll === true;
                pending.only = pending.only && only ? new Set([...pending.only, ...only]) : null;
            }
            // A per-game scan (audit panel) resolves when its follow-up run ends; plain requests are debounced re-runs.
            if (!only) return;
            return new Promise<void>((resolve) => pending!.waiters.push(resolve));
        }
        running = true;
        const force = options?.forceAll === true;
        try {
            await deps.ready();

            let items: { appid: number; name: string }[];
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
                items = [...newItems, ...missingItems];
            }

            if (items.length === 0) {
                setProgress({ isSyncing: false, phase: "idle", total: 0, current: 0 });
                return;
            }

            logger.info(`Ingest: ${items.length} shortcut(s)${force ? " (forced)" : ""}...`);
            setProgress({ isSyncing: true, total: items.length, current: 0, currentGame: items[0]?.name ?? "", phase: "scraping" });

            for (const [i, item] of items.entries()) {
                setProgress({ current: i + 1, currentGame: item.name });
                let outcome = { stop: false, done: false };
                try {
                    outcome = await ingestOne(item, force);
                } catch (e) {
                    logger.warn(`Ingest failed for ${item.appid}:`, e);
                }
                if (outcome.stop) {
                    logger.warn("A source is paused (rate limit or repeated errors); ingest stops and resumes next run.");
                    break;
                }
                if (outcome.done) {
                    deps.onDone?.(item.appid as ShortcutId);
                    await deps.backend.markKnown([item.appid], BACKGROUND).catch(() => undefined);
                }

                await deps.sleep(PAUSE_MS);
            }

            setProgress({ isSyncing: false, phase: "complete" });
            // Back to idle after a few seconds.
            const idle = setTimeout(() => {
                if (!running) setProgress({ phase: "idle" });
            }, 5000) as unknown as { unref?: () => void };
            idle.unref?.(); // never hold a Node test process open
        } catch (e) {
            logger.error("Ingest failed:", e);
            setProgress({ isSyncing: false, phase: "idle" });
        } finally {
            running = false;
            if (pending) {
                const next = pending;
                pending = null;
                const again = { forceAll: next.forceAll, onlyAppids: next.only ? [...next.only] : undefined };
                (deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms)))(() => void startSync(again).finally(() => next.waiters.forEach((w) => w())), 1000);
            }
        }
    }

    return {
        startSync,
        triggerSync(delayMs = 500) {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                debounce = null;
                void startSync();
            }, delayMs);
        },
        getSyncProgress: () => progress,
        onSyncProgress(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
