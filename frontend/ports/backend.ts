// The record facade RPC client (migration plan M4b/M4c; M5a extends it with
// metadata and GetAllRecords). Imports kernel types only; transport from
// ports/transport.ts.
import type { AchievementSet, AchievementUnlockRecord, ArtworkUrls, GameMetadata, Identity, OwnedCandidate, Part, RecordPart, Route, StoreApplied } from "../kernel/record";
import { call, type CallOptions } from "./transport";

export type { CallOptions, Lane } from "./transport";

/** A place a shortcut's unlocks come from, as the backend lists it (achievements_reset.lua). */
export interface AchievementResetSource {
    /** "rpcs3", "shadps4" or "retroachievements"; extension sources use the provider's id (ADR-0063). */
    id: string;
    label: string;
    resettable: boolean;
    unlocked: number;
    note?: string;
    /** A page where the user resets this source by hand (RetroAchievements: the game's page). */
    url?: string;
}

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

export interface IgdbCandidate {
    id: number;
    name: string;
    slug?: string;
    year?: number;
    platforms?: string[];
    summary?: string;
    cover?: string;
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
    setAchievementSource(appid: number, source: "ra" | "steam" | "none", target?: string | number) {
        return call<{ ok?: boolean; error?: string; source?: string; title?: string; total?: number; game_id?: number; steam_appid?: number }>(
            "SetAchievementSource",
            { appid, source, target },
        );
    },
    clearAchievementSource(appid: number) {
        return call<{ ok?: boolean; error?: string }>("ClearAchievementSource", { appid });
    },
    igdbSearch(query: string) {
        return call<{ candidates?: IgdbCandidate[]; error?: string }>("IgdbSearch", { query });
    },
    igdbLink(appid: number, igdb_id: number, title?: string) {
        return call<{ ok?: boolean; metadata?: GameMetadata; error?: string }>("IgdbLink", { appid, igdb_id, title });
    },
};
