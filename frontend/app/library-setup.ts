// app/library-setup: the Library Setup window's work (ADR-0086, plan § 6): list the library (offline), detect one game,
// store the user's answer, then fetch the game the user just validated. The backend owns the proposals and the answers;
// this passes each shortcut's Steam collections (a platform signal the backend cannot read) and runs the fetch through
// app/ingest. Running setup is the consent: the first Detect marks setup done, so the gate lets validated games through
// (a game that is not validated stays gated per game, choices_store.may_fetch).
import { logger } from "../logger.ts";
import { asList } from "../kernel/lists.ts";
import type { backend as Backend, SetupAnswer, SetupGame, SetupPlatform } from "../ports/backend";

export interface LibrarySetupDeps {
    backend: Pick<typeof Backend, "getSetupState" | "setSetupDone" | "finishOnboarding" | "answerOnboardingPrompt" | "resetPluginData" | "libraryScan" | "libraryDetect" | "validateGame" | "validateAllProposed">;
    /** Every shortcut in the library. */
    shortcuts(): { appid: number }[];
    /** The names of the Steam collections a shortcut is in (app/routing). */
    collectionsOf(appid: number): string[];
    /** Fetch these games now (app/ingest, a per-game run). */
    fetchGames(appids: number[]): Promise<void>;
    /** Forget every saved setting (settings.ts): the "start from zero" of the new-onboarding prompt. */
    resetSettings(): Promise<void>;
}

/** What the "new onboarding" prompt lets the user keep (ADR-0093). */
export interface StartOverOptions {
    zero: boolean;
    keepCredentials: boolean;
    keepSettings: boolean;
    keepMetadata: boolean;
}

export interface LibraryScanResult {
    games: SetupGame[];
    platforms: SetupPlatform[];
    error?: string;
}

/** A row after an answer; `fetchError` when the game was validated but its fetch failed. */
export type ValidatedGame = SetupGame & { fetchError?: string };

export interface LibrarySetup {
    /** Has the user run setup; undefined when the backend did not answer. */
    isDone(): Promise<boolean | undefined>;
    /** The setup state, with whether an older onboarding is on record (`upgrade`: ask whether to run the new one); undefined when the backend did not answer. */
    state(): Promise<{ done: boolean; onboarded: boolean; upgrade: boolean } | undefined>;
    /** The user chose to run the new onboarding: clear what was not kept, then the window follows. */
    startOver(options: StartOverOptions): Promise<void>;
    /** The backend forgot the setup state (Delete everything): the next Detect gives consent again. */
    forgetConsent(): void;
    /** The user chose to skip the new onboarding: nothing changes and the prompt is not asked again. */
    skipUpgrade(): Promise<void>;
    /** Has the user finished or skipped onboarding (the first-run limits and the greyed-out settings end with it); undefined when the backend did not answer. */
    isOnboarded(): Promise<boolean | undefined>;
    /** Onboarding is over: the window was finished, or skipped (`skipped`, at `step`). Logged by the backend, no user data. */
    finish(info: { skipped: boolean; step?: number; pending?: number }): Promise<void>;
    /** Every shortcut with its verdict and its answer or proposal. Offline. */
    scan(): Promise<LibraryScanResult>;
    /** Look one game up; stores only the proposal. Marks setup done the first time. */
    detect(appid: number): Promise<SetupGame>;
    /** Store the user's answer; a Yes or a manual link then fetches the game. */
    validate(appid: number, answer: SetupAnswer): Promise<ValidatedGame>;
    /** Confirm every proposed game at once; the confirmed games are then fetched. Answered games and games with nothing proposed are skipped, never clobbered. */
    validateAll(appids: number[], onProgress?: (done: number, total: number) => void): Promise<{ confirmed: number[]; skipped: number; failed: Record<string, string>; fetchError?: string }>;
}

/**
 * Games per ValidateAllProposed call. One game costs up to three network fetches (its Game Info link, its
 * RetroAchievements set) plus a disk write per store, and Millennium abandons the caller after 30 s
 * (knowledgebase "Millennium RPC"); 216 games in one call timed out. Ten stays under it with margin, and a
 * failed chunk throws while the earlier chunks stand (the backend call is idempotent: answered games are
 * skipped, so clicking again resumes where it stopped).
 */
export const VALIDATE_ALL_CHUNK = 10;

/** Lua sends an empty list as `{}`: the window reads plain arrays. */
function normalize(row: SetupGame): SetupGame {
    return { ...row, signals: asList<string>(row.signals), warnings: row.warnings === undefined ? undefined : asList<string>(row.warnings), source_issues: row.source_issues === undefined ? undefined : asList<string>(row.source_issues) };
}

export function createLibrarySetup(deps: LibrarySetupDeps): LibrarySetup {
    let markedDone = false;

    async function markDone(): Promise<void> {
        if (markedDone) return;
        const res = await deps.backend.setSetupDone(true);
        if (res?.error) throw new Error(res.error);
        markedDone = true;
        logger.info("Library Setup: setup marked done (the user ran Detect).");
    }

    return {
        async isDone() {
            const st = await deps.backend.getSetupState().catch(() => undefined);
            return st && !st.error ? st.done === true : undefined;
        },

        async state() {
            const st = await deps.backend.getSetupState().catch(() => undefined);
            if (!st || st.error) return undefined;
            return { done: st.done === true, onboarded: st.onboarded === true, upgrade: st.done === true && (st.version ?? 0) < (st.current ?? 0) };
        },

        async startOver(o) {
            const reset = await deps.backend.resetPluginData({
                zero: o.zero,
                clear: { credentials: !o.keepCredentials, settings: !o.keepSettings, metadata: !o.keepMetadata },
            });
            if (reset?.error) throw new Error(reset.error);
            if (o.zero && !o.keepSettings) await deps.resetSettings();
            if (!o.zero) {
                const res = await deps.backend.answerOnboardingPrompt("run");
                if (res?.error) throw new Error(res.error);
            }
            markedDone = false;
            logger.info(`Library Setup: new onboarding (${o.zero ? "from zero" : "over what is there"}).`);
        },

        forgetConsent() {
            markedDone = false;
        },

        async skipUpgrade() {
            const res = await deps.backend.answerOnboardingPrompt("skip");
            if (res?.error) throw new Error(res.error);
        },

        async isOnboarded() {
            const st = await deps.backend.getSetupState().catch(() => undefined);
            return st && !st.error ? st.onboarded === true : undefined;
        },

        async finish(info) {
            const res = await deps.backend.finishOnboarding(info);
            if (res?.error) throw new Error(res.error);
            markedDone = true;
            logger.info(`Library Setup: onboarding ${info.skipped ? "skipped" : "completed"}.`);
        },

        async scan() {
            const collections: Record<string, string[]> = {};
            for (const s of deps.shortcuts()) {
                const names = deps.collectionsOf(s.appid);
                if (names.length > 0) collections[String(s.appid)] = names;
            }
            const res = await deps.backend.libraryScan(collections);
            if (res?.error) return { games: [], platforms: [], error: res.error };
            return {
                games: asList<SetupGame>(res?.games).map((g) => ({ ...normalize(g), collections: deps.collectionsOf(g.appid) })),
                platforms: asList<SetupPlatform>(res?.platforms),
            };
        },

        async detect(appid) {
            await markDone();
            const row = await deps.backend.libraryDetect(appid, deps.collectionsOf(appid));
            return { ...normalize(row), collections: deps.collectionsOf(appid) };
        },

        async validate(appid, answer) {
            const row: ValidatedGame = {
                ...normalize(await deps.backend.validateGame(appid, answer, deps.collectionsOf(appid))),
                collections: deps.collectionsOf(appid),
            };
            if (row.error || !("yes" in answer || "linked" in answer)) return row;
            // The game is the user's now: fetch it (its stale parts were forgotten by the answer).
            try {
                await markDone();
                await deps.fetchGames([appid]);
            } catch (e) {
                row.fetchError = String((e as Error)?.message ?? e);
                logger.warn(`Library Setup: ${appid} validated, its fetch failed:`, e);
            }
            return row;
        },

        async validateAll(appids, onProgress) {
            const confirmed: number[] = [];
            let skipped = 0;
            const failed: Record<string, string> = {};
            for (let at = 0; at < appids.length; at += VALIDATE_ALL_CHUNK) {
                const chunk = appids.slice(at, at + VALIDATE_ALL_CHUNK);
                const res = await deps.backend.validateAllProposed(chunk);
                if (res?.error) throw new Error(res.error);
                confirmed.push(...asList<number>(res?.confirmed));
                skipped += res?.skipped ?? 0;
                Object.assign(failed, res?.failed ?? {});
                onProgress?.(Math.min(at + chunk.length, appids.length), appids.length);
            }
            const out = { confirmed, skipped, failed };
            if (confirmed.length === 0) return out;
            // The games are the user's now: fetch them in one run (as one Yes fetches one game).
            try {
                await markDone();
                await deps.fetchGames(confirmed);
            } catch (e) {
                logger.warn(`Library Setup: ${confirmed.length} validated, their fetch failed:`, e);
                return { ...out, fetchError: String((e as Error)?.message ?? e) };
            }
            return out;
        },
    };
}
