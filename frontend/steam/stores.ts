import { resolveClass, resolveService, resolveSingleton } from "./modules";

/**
 * Typed bindings onto Steam's own stores and services.
 *
 * These are the real objects the native app detail page uses. We do not wrap or
 * shadow them - we hand them data and let Steam render.
 *
 * Every shape here was read off the live client; see docs/steam-components.md
 * for the verbatim payloads and the probe session that produced them.
 */

// ---------------------------------------------------------------------------
// Payload shapes (exactly what Steam's own code produces and consumes)
// ---------------------------------------------------------------------------

/** One entry of `SteamClient.Apps.GetScreenshotsInTimeRange`. */
export interface SteamScreenshot {
    nAppID: number;
    strGameID: string;
    hHandle: number;
    nWidth: number;
    nHeight: number;
    nCreated: number;
    ePrivacy: number;
    strCaption: string;
    bSpoilers: boolean;
    /** Absolute `https://steamloopback.host/...` URL. Steam serves this itself. */
    strUrl: string;
    bUploaded: boolean;
    ugcHandle: string;
    publishedFileID: string;
}

/** One clip, as `CGameRecordingService.GetClips` returns it. */
export interface SteamClip {
    clip_id: string;
    game_id: string;
    duration_ms: string;
    date_recorded: number;
    start_timeline_id: string;
    start_offset_ms: string;
    file_size: string;
    date_clipped: number;
    temporary: boolean;
    thumbnail_url: string;
    thumbnail_width: number;
    thumbnail_height: number;
}

/** A session event: exactly one key is populated. */
export type SessionEvent =
    | { m_screenshot: SteamScreenshot }
    | { m_clip: SteamClip };

/** Steam's `CGamePlaySession`. */
export interface GamePlaySession {
    PushSessionEvent(event: SessionEvent): void;
    BAddScreenshotNotification(notification: {
        strOperation: "written" | "deleted";
        unAppID: number;
        hScreenshot: number;
        details: SteamScreenshot;
    }): boolean;
    AddClip(clip: SteamClip): void;
    RemoveClip(clipId: string): void;
    GetSessionEvents(): SessionEvent[];
    ClearSessionEvents(): SessionEvent[];
    HasSessionEvents(): boolean;
}

/** Steam's per-app spotlight state. */
export interface SpotlightAppData {
    m_unAppID: number;
    m_session: GamePlaySession;
    m_postGameSummary: GamePlaySession | null;
    m_bLoadedPreviousSessionData: boolean;
}

/** Steam's `CAppSpotlightStore` singleton. */
export interface AppSpotlightStore {
    GetOrCreateAppData(appid: number): SpotlightAppData;
    GetPostGameSummary(appid: number): GamePlaySession | null;
    EnterAppDetailsPage(appid: number): void;
    ExitAppDetailsPage(appid: number): void;
    StopShowingGamePlaySpotlight(appid: number): void;
}

/** The section registry component that decides which sections a page shows. */
export interface AppDetailsSections {
    prototype: {
        GetSections(overview: unknown, details: unknown): Set<string>;
        m_setSectionsMemo?: Set<string>;
    };
}

/** Steam's game-recording CM service. */
interface GameRecordingService {
    GetClips(request: { game_id: string; created_after: number }): Promise<{
        Body(): { clip(): Array<{ toObject(): SteamClip }> | undefined };
    }>;
}

/** One day's worth of activity feed events. */
export interface AppActivityDay {
    m_rtDayBegin: number;
    dayBegin: number;
    m_rgEvents: any;
    events: any[];
    BHasEvents(): boolean;
    isValid?: boolean;
    GetLatestEventTime?(): number;
    GetEarliestEventTime?(): number;
    SortEvents?(): void;
    AddEvent?(event: any): void;
}

/** Per-app activity state. */
export interface AppActivity {
    m_unAppID: number;
    /** Steam's CAppActivity time bounds (rtime32): read by FetchLatestActivityFromServer / FetchActivityHistory. */
    m_rtEarliestUserNewsTime?: number;
    m_rtEarliestGameActivityTime?: number;
    m_rtLatestUserNewsTime?: number;
    m_rtLatestGameActivityTime?: number;
    m_rgCachedUserNewsEvents?: unknown[];
    m_rgCachedGameActivityEvents?: unknown[];
    m_bNoMoreHistoryAvailable?: boolean;
    readonly earliest_user_news_time?: number;
    readonly earliest_game_activity_time?: number;
    readonly latest_user_news_time?: number;
    readonly latest_game_activity_time?: number;
    /** What FetchLatestActivityFromServer calls on the entry after the requests answer. */
    MergeUserNews?(body: unknown): Promise<void>;
    MergeGameActivity?(body: unknown, steamid?: unknown): void;
    GetAchievementMapCache?(): string;
    GetUserNewsCache?(): unknown[];
    GetGameActivityCache?(): unknown[];
    m_mapActivityByDay: Map<number, AppActivityDay>;
    appActivityByDay: AppActivityDay[];
    lastAddedEventType?: number;
    lastAddedPartnerEvent?: any;
    BHasEvents?(): boolean;
}

/** Steam's `CAppActivityStore` singleton. */
export interface AppActivityStore {
    m_mapAppActivity: Map<number, AppActivity>;
    /** Apps whose server fetch is in flight; FetchLatestActivity returns at once for an app in it. */
    m_setAppFetchRequested?: Set<number>;
    GetAppActivity(appid: number): AppActivity | undefined;
    RestoreActivity(appid: number): Promise<void>;
}

/** Steam's in-memory `StoreItemCache` singleton. */
export interface StoreItemCache {
    m_mapApps: Map<number, any>;
    m_setUnavailableApps?: Set<number>;
    BIsAppMissing?(appid: number): boolean;
    GetStoreItemWithLegacyVisibilityCheck(
        appid: number,
        storeItemType: number,
    ): any;
}

/** Steam's `CSteamID` shape. */
export interface SteamID {
    GetAccountID(): number;
    ConvertTo64BitString(): string;
    BIsValid(): boolean;
}

/** Steam's `CFriendStore` singleton. */
export interface FriendStore {
    currentUserSteamID?: SteamID;
    GetFriendState?(steamid: SteamID): any;
}

// ---------------------------------------------------------------------------
// Resolution — by prototype signature only, never by module id
// ---------------------------------------------------------------------------

/**
 * `CAppSpotlightStore`. Identified by two methods that exist together nowhere
 * else: the summary getter and the spotlight dismissal.
 */
export function spotlightStore(): AppSpotlightStore | undefined {
    return resolveSingleton<AppSpotlightStore>("CAppSpotlightStore", [
        "GetPostGameSummary",
        "StopShowingGamePlaySpotlight",
        "GetOrCreateAppData",
    ]);
}

/**
 * The app-details sections component. `GetSections` alone is too generic, so
 * pair it with the scroll-seek and registration methods it ships beside.
 */
export function appDetailsSections(): AppDetailsSections | undefined {
    return resolveClass<AppDetailsSections>("CAppDetailsSections", [
        "GetSections",
        "SeekToSection",
        "RegisterSection",
    ]);
}

/**
 * The game-recording service that backs clips.
 *
 * `GetAndTrimPostGameHighlights` is the disambiguator: several modules expose a
 * `GetClips`, but only this service carries both.
 */
function gameRecordingService(): GameRecordingService | undefined {
    return resolveService<GameRecordingService>("CGameRecordingService", [
        "GetClips",
        "GetAndTrimPostGameHighlights",
    ]);
}

/**
 * `CAppActivityStore`. Resolved via global window object or by prototype methods.
 */
export function appActivityStore(): AppActivityStore | undefined {
    const globalStore = Reflect.get(globalThis, "appActivityStore") as
        | AppActivityStore
        | undefined;
    if (globalStore) return globalStore;
    return resolveSingleton<AppActivityStore>("CAppActivityStore", [
        "GetAppActivity",
        "RestoreActivity",
    ]);
}

/**
 * `StoreItemCache`. Pure in-memory cache backing legacy store item visibility checks.
 */
export function storeItemCache(): StoreItemCache | undefined {
    const globalCache = Reflect.get(globalThis, "StoreItemCache") as
        | StoreItemCache
        | undefined;
    if (globalCache) return globalCache;
    return resolveSingleton<StoreItemCache>("StoreItemCache", [
        "GetStoreItemWithLegacyVisibilityCheck",
    ]);
}

/**
 * `CFriendStore`. Provides currentUserSteamID and friend states.
 */
export function friendStore(): FriendStore | undefined {
    const globalFs = Reflect.get(globalThis, "friendStore") as
        | FriendStore
        | undefined;
    if (globalFs) return globalFs;
    return resolveSingleton<FriendStore>("CFriendStore", [
        "currentUserSteamID",
        "GetFriendState",
    ]);
}

/**
 * The constructor for Steam's native screenshot event class (`V` in module 12750).
 */
export function screenshotEventClass(): any | undefined {
    return resolveClass<any>("CScreenshotEvent", [
        "AddScreenshot",
        "GetCurrentPublishedFileID",
    ]);
}

/**
 * The prototype every activity event shares (`E` in module 12750: InitFromUserNewsEvent, BIsValid, GetParentalFeature,
 * comment threads), reached as the parent of the exported screenshot class. Steam's achievement event class (`P`) is
 * not exported; an object on this prototype with P's fields (m_rgAchievements, m_rtOldestAchievement, an
 * `achievements` getter) renders as Steam's own "achieved" card (verified live 2026-10-02, ADR-0056).
 */
export function activityEventBase(): object | undefined {
    const proto = screenshotEventClass()?.prototype;
    return proto ? (Object.getPrototypeOf(proto) as object | undefined) ?? undefined : undefined;
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

interface AppsApi {
    GetScreenshotsInTimeRange?: (
        appid: number,
        start: number,
        end: number,
    ) => Promise<SteamScreenshot[]>;
}

/**
 * Screenshots Steam already indexed for this app.
 *
 * Works unmodified for non-Steam games: Steam indexes a shortcut's screenshots
 * exactly like a native game's, keyed by the 32-bit appid, and hands back
 * absolute loopback URLs it serves itself. Verified live on AM2R (4 shots).
 *
 * This is why the plugin no longer needs base64 image transport for the
 * summary - Steam was always willing to serve these.
 */
export async function screenshotsSince(
    appid: number,
    since: number,
): Promise<SteamScreenshot[]> {
    // Cast through `unknown`: the SDK's own `Screenshot` type is narrower than
    // what ships (it omits `publishedFileID` among others), and this is
    // undocumented client surface that varies between builds regardless.
    const client = Reflect.get(globalThis, "SteamClient") as unknown as
        | { Apps?: AppsApi }
        | undefined;
    const apps = client?.Apps;
    const fn = apps?.GetScreenshotsInTimeRange;
    if (typeof fn !== "function") return [];

    try {
        return (await fn.call(apps, appid, since, 0)) ?? [];
    } catch {
        return [];
    }
}

/**
 * Clips Steam recorded for this game.
 *
 * Takes the **64-bit gameid**, not the appid. Steam's own helper truncates a
 * shortcut's gameid to 32 bits, which is precisely why its native path finds no
 * clips for non-Steam games - the service itself is perfectly willing to return
 * them when asked correctly. Verified live: 3 clips for AM2R.
 */
export async function clipsSince(
    gameid: string,
    since: number,
): Promise<SteamClip[]> {
    const service = gameRecordingService();
    if (!service) return [];

    try {
        const response = await service.GetClips({
            game_id: gameid,
            created_after: since,
        });
        return (response.Body().clip() ?? []).map((c) => c.toObject());
    } catch {
        return [];
    }
}
