// The record facade RPC client (migration plan M4b/M4c; M5a extends it with
// metadata and GetAllRecords). Imports kernel types only; transport from
// ports/transport.ts.
import type { AchievementSet, AchievementUnlockRecord, ArtworkUrls, GameMetadata, Identity, OwnedCandidate, Part, RecordPart, Route, StoreApplied } from "../kernel/record";
import { call, type CallOptions } from "./transport";

export type { CallOptions, Lane } from "./transport";

/** A place a shortcut's unlocks come from, as the backend lists it (achievements_reset.lua). */
export interface AchievementResetSource {
    /** "rpcs3", "shadps4", "native_port" or "retroachievements"; extension sources use the provider's id (ADR-0063). */
    id: string;
    label: string;
    resettable: boolean;
    unlocked: number;
    note?: string;
    /** A page where the user resets this source by hand (RetroAchievements: the game's page). */
    url?: string;
}

/** A list from the backend: an empty one may arrive as `{}` (K1); read it with kernel/lists asList. */
type WireList<T> = T[] | Record<string, never>;

/** An achievement pack as the backend lists it (packs_rpc.lua, ADR-0081, ADR-0083). */
export interface AchievementPackInfo {
    id: string;
    file: string;
    count: number;
    /** Ships with the plugin (backend/packs), ready to use. */
    bundled?: boolean;
    /** The user's pack with a shipped pack's id: it replaces that one. */
    replaces_bundled?: boolean;
    /** Shortcuts this pack is chosen for. */
    games: WireList<number>;
    /** Shortcuts it matches where another pack, or a built-in port, is used instead. */
    not_chosen: WireList<{ appid: number; chosen?: string }>;
}

export interface AchievementPacksState {
    folder?: string;
    /** Where the packs that ship with the plugin are. */
    bundled_folder?: string;
    packs?: WireList<AchievementPackInfo>;
    /** Files in the folders that are not packs, and why. */
    problems?: WireList<{ name: string; file: string; errors: WireList<string> }>;
    error?: string;
}

/** Which pack a shortcut uses and what it reads (the Cartridge card). */
export interface AchievementPackExplain {
    pack?: string;
    /** The user gave the game this pack in the Game Data editor (not matched by its exe). */
    assigned?: boolean;
    others?: WireList<{ id: string; why: string }>;
    files?: WireList<{ path: string; state: "found" | "missing" | "unreadable"; unlocks: number }>;
    marked_none?: boolean;
    error?: string;
}

/** Library Setup (ADR-0086): what the plugin proposes for a game (library_service.lua detect). */
export interface SetupProposal {
    title?: string;
    platform?: string;
    state?: string;
    steam_appid?: number;
    steam_name?: string;
    /** "exact" or "edition" (plan Q9). */
    steam_kind?: string;
    igdb_id?: number;
    igdb_name?: string;
    ss_id?: number;
    ss_name?: string;
    ra_game_id?: number;
    ra_title?: string;
    /** "hash" or "title". */
    ra_by?: string;
    year?: number;
    /** What the source said about the game (IGDB / ScreenScraper), for the question's details. */
    platforms?: string[];
    genres?: string[];
    franchises?: string[];
    developers?: string[];
    themes?: string[];
    game_modes?: string[];
    perspectives?: string[];
}

/** The user's answer for a game (choices_store.lua). */
export interface SetupChoice {
    kind: "validated" | "existing" | "skipped";
    platform?: string;
    steam_appid?: number;
    igdb_id?: number;
    ss_id?: number;
    ra_game_id?: number;
    /** "ra", "steam", a pack, or "none" (the user said the game has none). */
    achievements?: string;
}

/** One row of the setup list (library_service.lua row). `error` instead when the call failed. */
export interface SetupGame {
    appid: number;
    name: string;
    /** platform_verdict state: steam | steam-proposed | other | conflict | unknown. */
    state?: string;
    platform?: string;
    platform_name?: string;
    /** The Steam collections the game is in (filled by app/library-setup, not by the backend). */
    collections?: string[];
    signals?: WireList<string>;
    status?: "validated" | "existing" | "skipped" | "conflict" | "not-detected" | "needs-link" | "proposed";
    choice?: SetupChoice;
    proposal?: SetupProposal;
    metadata?: { title?: string; igdb_id?: number; ss_id?: number };
    /** The game's stored achievement source, if any. */
    achievements?: string;
    warnings?: WireList<string>;
    error?: string;
}

/** A platform the manual link offers (platforms.lua). */
export interface SetupPlatform {
    id: string;
    name: string;
}

export type SetupAnswer =
    | { yes: true }
    | { no: true }
    | { linked: true; platform?: string }
    | { no_achievements: true }
    | { skip: true }
    | { reset: true };

/** What a reset did to one source. */
export interface ResetSourceResult {
    id: string;
    ok: boolean;
    cleared: number;
    error?: string;
}

export interface ProviderStatus {
    has_twitch: boolean;
    has_sgdb: boolean;
    has_screenscraper?: boolean;
    has_retroachievements?: boolean;
    status: "ready" | "needs_credentials";
    db_count: number;
}



export interface EmulatorStatusItem {
    name: string;
    detected: boolean;
    path?: string;
    username?: string;
    authenticated: boolean;
}

export interface RetroStatusResponse {
    emulators: EmulatorStatusItem[];
    env_fallback: boolean;
    env_username?: string;
}

/** Structural copy of domain/routing AutoRoutingProfile (ports import the kernel only). */
export interface AutoRoutingProfileDto {
    category: "retroarch" | "console_emulator" | "pc";
    program?: string;
}

export interface LibraryStat {
    screenshots: number;
    /** Unix seconds of the newest capture; 0 when unknown. */
    newest: number;
}

export type StoreSource = "manual" | "owned" | "search";
export interface StoreMapping {
    steam_appid: number;
    name: string;
    source: StoreSource;
    at?: number;
}
export interface StoreSuggestion {
    steam_appid: number;
    name: string;
    reason: "edition" | "near";
}
export interface StoreState {
    mappings: Record<string, StoreMapping>;
    suggestions: Record<string, StoreSuggestion[]>;
    rejected: Record<string, number[]>;
    applied_artwork: Record<string, StoreApplied>;
}

export interface StoreCandidate {
    steam_appid: number;
    name: string;
}

export interface FreshContext {
    /** The shortcut's display name (""  when unknown). */
    title: string;
    /** The frontend's evaluated routing policy (ADR-0040). */
    route: Route;
    /** Identity only: natives Steam already knows (sensors/owned-apps). */
    owned?: OwnedCandidate[];
    /** Metadata only (M5): StoreItemCache data for identity.native. */
    storeItem?: GameMetadata | null;
    /** Metadata only (M5): igdb enabled and allowed by routing. */
    allowWeb?: boolean;
    /** Metadata only (M5d): screenscraperEnabled and allowed by routing. */
    allowScreenscraper?: boolean;
    /** Metadata and artwork: the identity the frontend already knows. An "ok" result with no
     *  native match is never persisted, so the backend cannot recover it from disk. */
    identity?: Part<Identity>;
    /** Artwork only (M5c): hashed StoreItemCache URLs for the mapped native app. */
    artUrls?: ArtworkUrls;
    /** Artwork only (M5c): services.steamgriddbEnabled and routing allow SteamGridDB. */
    allowSgdb?: boolean;
    /** true = disk and context only (bulk re-evaluation). */
    noNetwork?: boolean;
    /** Achievements only (M6a): setting raHardcoreMode. */
    hardcore?: boolean;
    /** M7a: ignore TTLs, never a custom_override record. */
    force?: boolean;
    /** Media only (features plan F2): the IGDB game Game Info shows; IGDB media is asked by this id, never by title. */
    igdb_id?: number;
    /** Media only (ADR-0051): setting mediaCacheDays; more than 0 counts this page open for the disk cache. */
    cacheDays?: number;
}

/** One ScreenScraper image of the media part (features plan F2b): the bytes, never the URL. */
export interface MediaImageResponse {
    base64?: string;
    ext?: string;
    width?: number;
    height?: number;
    error?: string;
}

/** One chunk of a ScreenScraper manual (features plan F2c): 1 MiB of the PDF as base64, never the URL. */
export interface ManualChunkResponse {
    base64?: string;
    index?: number;
    chunks?: number;
    size?: number;
    error?: string;
}

export interface ManualCoverResponse {
    base64?: string;
    ok?: boolean;
    error?: string;
}

export interface RecordResponse {
    appid: number;
    parts: Partial<Record<RecordPart, Part<unknown>>>;
    /** Set instead of parts when the call failed. */
    error?: string;
    /** Sources the backend has paused (429, or repeated failures), by source id (M7a). */
    paused?: Record<string, number>;
}

export const backend = {
    ensureFresh(appid: number, parts: RecordPart[], ctx: FreshContext, opts?: CallOptions): Promise<RecordResponse> {
        return call<RecordResponse>("EnsureFresh", { appid, parts, context: ctx }, opts);
    },
    /** New unlocks since the last check (M6a). `new_unlocks` may arrive as `{}` (K1): normalize it. */
    checkUnlocks(appid: number, native: number, title?: string, opts?: CallOptions): Promise<{ new_unlocks?: unknown; error?: string }> {
        return call<{ new_unlocks?: unknown; error?: string }>("CheckUnlocks", { appid, native, title }, opts);
    },
    /** Test hook and manual unlock (`triggerAchievement`, public API). */
    unlockAchievement(appid: number, achievementId: string, unlockTime?: number) {
        return call<{ ok: boolean; unlocks: Record<string, AchievementUnlockRecord>; error?: string }>(
            "CartridgesAchievementsUnlock",
            { shortcut_appid: appid, achievement_id: achievementId, unlock_time: unlockTime },
        );
    },
    /** Clears the plugin's unlocks and the chosen sources' files, each backed up first (ADR-0054). */
    resetAchievements(appid: number, opts: { native?: number; sources?: string[]; title?: string } = {}) {
        return call<{ ok: boolean; sources?: ResetSourceResult[] | Record<string, never>; error?: string }>(
            "CartridgesAchievementsReset",
            { shortcut_appid: appid, native_appid: opts.native ?? 0, sources: opts.sources ?? [], title: opts.title ?? "" },
        );
    },
    /** Where a shortcut's unlocks come from besides the plugin's store, and which can be reset. */
    resetAchievementSources(appid: number, native = 0) {
        return call<{ sources?: AchievementResetSource[] | Record<string, never>; error?: string }>(
            "CartridgesAchievementsResetSources",
            { shortcut_appid: appid, native_appid: native },
        );
    },
    /** Shortcuts not seen before (M7a). The first call seeds the library and returns none. */
    getNewShortcuts(opts?: CallOptions): Promise<{ shortcuts?: unknown }> {
        return call<{ shortcuts?: unknown }>("GetNewShortcuts", {}, opts);
    },
    markKnown(appids: number[], opts?: CallOptions): Promise<{ ok?: boolean; error?: string }> {
        return call<{ ok?: boolean; error?: string }>("MarkKnown", { appids }, opts);
    },
    /** The native PC ports the plugin supports and how many shortcuts launch each (the Achievements section's info window). */
    getNativePortsStatus(): Promise<{ ports?: { id: string; name: string; detected: number }[]; error?: string }> {
        return call<{ ports?: { id: string; name: string; detected: number }[]; error?: string }>("CartridgesAchievementsGetNativePortsStatus");
    },
    /** One line in the plugin's log file (the log users share): counts and feature names, never a name, key or path (ADR-0094). Never throws. */
    logEvent(tag: string, message: string): void {
        void call<unknown>("ClientLog", { tag, message }, { lane: "background" }).catch(() => undefined);
    },
    /** The backend's second copy of the settings (ADR-0090): used when Millennium's Configuration API gives nothing back. */
    getSettings(): Promise<{ values?: Record<string, unknown>; error?: string }> {
        return call<{ values?: Record<string, unknown>; error?: string }>("GetSettings", {});
    },
    saveSettings(change: { values?: Record<string, unknown>; remove?: string[] }): Promise<{ changed?: number; error?: string }> {
        return call<{ changed?: number; error?: string }>("SaveSettings", change);
    },
    /** Library Setup (ADR-0086): has the user run it. Until then the backend fetches nothing on its own. */
    getSetupState(opts?: CallOptions): Promise<{ done?: boolean; onboarded?: boolean; at?: number; why?: string; version?: number; current?: number; error?: string }> {
        return call<{ done?: boolean; onboarded?: boolean; at?: number; why?: string; version?: number; current?: number; error?: string }>("GetSetupState", {}, opts);
    },
    /** The "new onboarding" prompt (ADR-0093): the user chose to run it or to skip it. */
    answerOnboardingPrompt(prompt: "run" | "skip") {
        return call<{ done?: boolean; onboarded?: boolean; error?: string }>("SetSetupDone", { done: true, prompt });
    },
    /** Game Data editor: forgets what the plugin fetched or learned about one game (Game Info, achievements, proposal, answer, freshness, media). Irreversible. */
    deleteGameMetadata(appid: number) {
        return call<{ ok?: boolean; error?: string }>("DeleteGameMetadata", { appid });
    },
    /** Starts over for a new onboarding: with `zero`, the groups in `clear` are moved aside (nothing is deleted) and the setup state is cleared. */
    resetPluginData(change: { zero: boolean; clear: { credentials?: boolean; settings?: boolean; metadata?: boolean } }) {
        return call<{ moved?: number; backup?: string; error?: string }>("ResetPluginData", change);
    },
    /** Library Setup window: marks setup run (`done = false` starts over: nothing is fetched until the next run). */
    setSetupDone(done: boolean) {
        return call<{ done?: boolean; onboarded?: boolean; at?: number; why?: string; error?: string }>("SetSetupDone", { done });
    },
    /** Onboarding finished, or skipped (`skipped`, at `step`): lifts the first-run limits. `pending` = games in scope still to fetch (logged, no user data). */
    finishOnboarding(info: { skipped: boolean; step?: number; pending?: number }) {
        return call<{ done?: boolean; onboarded?: boolean; error?: string }>("SetSetupDone", { done: true, onboarded: true, ...info });
    },
    /** Library Setup step 4: every shortcut with its platform verdict and its answer or proposal. Offline. */
    libraryScan(collections: Record<string, string[]>) {
        return call<{ games?: WireList<SetupGame>; platforms?: WireList<SetupPlatform>; error?: string }>("LibraryScan", { collections });
    },
    /** Library Setup: look one game up (Steam store, RetroAchievements hash, IGDB, ScreenScraper); stores only the proposal. */
    libraryDetect(appid: number, collections: string[]) {
        return call<SetupGame>("LibraryDetect", { appid, collections });
    },
    /** Library Setup: the user's answer for one game. A validated game may be fetched; nothing is fetched here. */
    validateGame(appid: number, answer: SetupAnswer, collections: string[]) {
        return call<SetupGame>("ValidateGame", { appid, answer, collections });
    },
    /** Game Data editor: stores a manual edit (custom_override) and returns the metadata part to put in the record. */
    saveCustomMetadata(appid: number, metadata: GameMetadata) {
        return call<{ part?: Part<GameMetadata>; error?: string }>("SaveCustomMetadata", { appid, metadata });
    },
    /** Game Data editor: drops the manual edit; follow with ensureFresh(["metadata"]) for the fetched data. */
    clearCustomMetadata(appid: number) {
        return call<{ removed?: boolean; error?: string }>("ClearCustomMetadata", { appid });
    },
    /** Community media (features plan F2b): one ScreenScraper image, from the backend's disk cache (cacheDays > 0, ADR-0051) or downloaded. */
    getMediaImage(appid: number, key: string, title?: string, cacheDays?: number, opts?: CallOptions): Promise<MediaImageResponse> {
        return call<MediaImageResponse>("GetMediaImage", { appid, key, title, cacheDays }, opts);
    },
    /** Manuals (features plan F2c): chunk `index` (0-based) of a ScreenScraper PDF; chunk 0 downloads it in the backend. */
    getManualChunk(appid: number, key: string, index: number, title?: string, cacheDays?: number, opts?: CallOptions): Promise<ManualChunkResponse> {
        return call<ManualChunkResponse>("GetManualChunk", { appid, key, index, title, cacheDays }, opts);
    },
    /** Manuals (features plan F2c): the stored first-page cover as base64, or an answer without `base64` when none is stored. */
    getManualCover(appid: number, key: string, cacheDays?: number, opts?: CallOptions): Promise<ManualCoverResponse> {
        return call<ManualCoverResponse>("GetManualCover", { appid, key, cacheDays }, opts);
    },
    /** Manuals (features plan F2c): store the rendered first page, so the next start skips the PDF. */
    saveManualCover(appid: number, key: string, base64: string, cacheDays?: number, opts?: CallOptions): Promise<ManualCoverResponse> {
        return call<ManualCoverResponse>("SaveManualCover", { appid, key, base64, cacheDays }, opts);
    },
    /** Downloaded media on disk (ADR-0051): delete the downloads of every game not opened in the last `days` days (all for 0). */
    pruneMediaCache(days: number, opts?: CallOptions): Promise<{ removed?: number; kept?: number; error?: string }> {
        return call<{ removed?: number; kept?: number; error?: string }>("PruneMediaCache", { days }, opts);
    },
    /** ADR-0067: keep what an extension found for a shortcut (Game Info, media); `changed` when the core's copy changed. */
    provideGame(appid: number, game: { source: string; provider: string; title?: string; metadata?: unknown; media?: unknown }, opts?: CallOptions) {
        return call<{ ok?: boolean; changed?: boolean; error?: string }>("ProvideGame", { appid, ...game }, opts);
    },
    /** ADR-0067: drop what an extension pushed for a shortcut. */
    forgetProvidedGame(appid: number, opts?: CallOptions) {
        return call<{ ok?: boolean; error?: string }>("ForgetProvidedGame", { appid }, opts);
    },
    /** ADR-0067: the player's achievements as an extension found them; the stored part and the ids that were new. */
    provideAchievements(
        appid: number,
        set: { source: string; provider: string; key: string; schema: { title?: string; achievements: unknown[] }; unlocks: Record<string, number>; native?: number },
        opts?: CallOptions,
    ) {
        return call<{ ok?: boolean; part?: Part<AchievementSet>; new?: string[]; error?: string }>("ProvideAchievements", { appid, ...set }, opts);
    },
    /** Disk only: every DB record and every saved mapping (M5a). */
    getAllRecords(opts?: CallOptions): Promise<{ records: Record<string, RecordResponse["parts"]> }> {
        return call<{ records: Record<string, RecordResponse["parts"]> }>("GetAllRecords", {}, opts);
    },
    /** Provider credentials present, and how many games the database holds. */
    getStatus(): Promise<ProviderStatus> {
        return call<ProviderStatus>("GetStatus");
    },
    /** Settings: one small request to the service with the saved account; `message` says why when it is refused. */
    testService(service: "igdb" | "screenscraper" | "steamgriddb" | "retroachievements") {
        return call<{ ok?: boolean; message?: string; error?: string }>("TestServiceConnection", { service });
    },
    saveServiceCredentials(credentials: Record<string, string>) {
        return call<{ success: boolean; error?: string }>("SaveServiceCredentials", credentials);
    },
    /** Which emulators the RetroAchievements source can read (M8b, moved from rpc.ts). */
    getRetroStatus(): Promise<RetroStatusResponse> {
        return call<RetroStatusResponse>("CartridgesAchievementsGetRetroStatus");
    },
    /** Capture counts and newest timestamps per shortcut. */
    getLibraryStats(opts?: CallOptions) {
        return call<Record<string, LibraryStat>>("GetLibraryStats", {}, opts);
    },
    /** Controller support inferred from each shortcut's emulator (parity plan F); unknown games are absent. */
    getControllerInference(opts?: CallOptions) {
        return call<{ games?: Record<string, boolean> }>("GetControllerInference", {}, opts);
    },
    /** Auto-routing category profiles inferred from shortcut executable and launch options. */
    getAutoRoutingProfiles(opts?: CallOptions) {
        return call<{ profiles?: Record<string, AutoRoutingProfileDto> }>("GetAutoRoutingProfiles", {}, opts);
    },
    steamStoreGetState() {
        return call<StoreState>("SteamStoreGetState");
    },
    steamStoreGetMapping(appid: number) {
        return call<{ mapping: StoreMapping | null; rejected: number[]; applied: StoreApplied | null }>("SteamStoreGetMapping", { appid });
    },
    steamStoreSetMapping(appid: number, steam_appid: number, name?: string) {
        return call<{ mapping?: StoreMapping; error?: string }>("SteamStoreSetMapping", { appid, steam_appid, name });
    },
    steamStoreClearMapping(appid: number, reject: boolean) {
        return call<{ steam_appid?: number; slots: number[]; error?: string }>("SteamStoreClearMapping", { appid, reject });
    },
    /** Read-only store search for the manual link picker: nothing is mapped or cached. */
    steamStoreSearchCandidates(term: string) {
        return call<{ candidates: StoreCandidate[]; error?: string }>("SteamStoreSearchCandidates", { term });
    },
    steamStoreRecordArtwork(
        appid: number,
        steam_appid: number | undefined,
        slots: number[],
        failed: number[],
        extra?: { source?: "steamgriddb"; tried?: number[] },
    ) {
        return call<{ ok?: boolean; error?: string }>("SteamStoreRecordArtwork", { appid, steam_appid, slots, failed, ...extra });
    },
    /** Icon plan: store our copy of the icon image; `previous` is the shortcuts.vdf value it replaces. */
    steamStoreSaveIcon(appid: number, url: string, source: "steam-cdn" | "steamgriddb", steam_appid?: number, base64?: string) {
        return call<{ path?: string; previous?: string; error?: string }>("SteamStoreSaveIcon", { appid, url, source, steam_appid, base64 });
    },
    /** Icon plan: remember the icon the artwork surface set; `error` = the match changed meanwhile. */
    steamStoreRecordIcon(appid: number, info: { path: string; previous: string; source: "steam-cdn" | "steamgriddb"; steamAppid?: number }) {
        return call<{ ok?: boolean; error?: string }>("SteamStoreRecordIcon", {
            appid,
            path: info.path,
            previous: info.previous,
            source: info.source,
            steam_appid: info.steamAppid,
        });
    },
    setAchievementSource(appid: number, source: "ra" | "none" | "pack", target?: string | number) {
        return call<{ ok?: boolean; error?: string; source?: string; title?: string; total?: number; game_id?: number; steam_appid?: number; pack?: string }>(
            "SetAchievementSource",
            { appid, source, target },
        );
    },
    clearAchievementSource(appid: number) {
        return call<{ ok?: boolean; error?: string }>("ClearAchievementSource", { appid });
    },
    /** The achievement packs, shipped and the user's, read from their folders again (ADR-0081, ADR-0083). */
    achievementPacksList() {
        return call<AchievementPacksState>("AchievementPacksList", {});
    },
    achievementPacksExplain(appid: number) {
        return call<AchievementPackExplain>("AchievementPacksExplain", { appid });
    },
    /** `preview`: return the game without saving it (the user confirms first, ADR-0079). */
    igdbLink(appid: number, igdb_id: number, title?: string, preview?: boolean) {
        return call<{ ok?: boolean; preview?: boolean; metadata?: GameMetadata; error?: string }>("IgdbLink", { appid, igdb_id, title, preview });
    },
    /** `preview`: return the game without saving it (the user confirms first, ADR-0079). */
    screenscraperLink(appid: number, ss_id: number, title?: string, preview?: boolean) {
        return call<{ ok?: boolean; preview?: boolean; metadata?: GameMetadata; error?: string }>("ScreenscraperLink", { appid, ss_id, title, preview });
    },
};
