import { logger } from "../../logger";
import { isShortcutAppId } from "../../kernel/appid";
import type { AchievementSet } from "../../kernel/record";
import { deps } from "./deps";
import { achievementDays, type ActivityAchievementDay } from "./achievement-days";
import {
    activityEventBase,
    appActivityStore,
    clipsSince,
    friendStore,
    screenshotsSince,
    screenshotEventClass,
    storeItemCache,
    type AppActivity,
    type AppActivityDay,
    type AppActivityStore,
} from "../../steam/stores";

const ACTIVITY_TIMESTAMPS_KEY = "steam-cartridges:activity-timestamps";

interface AppActivityTimestamps {
    addedToLibrary?: number;
    firstPlayed?: number;
}

function getActivityTimestamps(appid: number): AppActivityTimestamps {
    try {
        const raw = localStorage.getItem(ACTIVITY_TIMESTAMPS_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            return data[appid] || {};
        }
    } catch {
        // ignore
    }
    return {};
}

function saveActivityTimestamps(appid: number, patch: Partial<AppActivityTimestamps>): void {
    try {
        const raw = localStorage.getItem(ACTIVITY_TIMESTAMPS_KEY);
        const data = raw ? JSON.parse(raw) : {};
        data[appid] = { ...data[appid], ...patch };
        localStorage.setItem(ACTIVITY_TIMESTAMPS_KEY, JSON.stringify(data));
    } catch {
        // ignore
    }
}

function getCommunityIconUrl(appid: number, overview: any): string {
    if (overview?.icon_data) {
        const fmt = overview.icon_data_format || "png";
        return overview.icon_data.startsWith("data:")
            ? overview.icon_data
            : `data:image/${fmt};base64,${overview.icon_data}`;
    }
    if (typeof (window as any).SteamClient?.Apps?.RequestIconDataForApp === "function") {
        (window as any).SteamClient.Apps.RequestIconDataForApp(appid);
    }
    return "";
}

function createActivityDay(dayBegin: number): AppActivityDay {
    const eventsList: any[] = [];
    return {
        m_rtDayBegin: dayBegin,
        get dayBegin() {
            return this.m_rtDayBegin;
        },
        set dayBegin(v: number) {
            this.m_rtDayBegin = v;
        },
        m_rgEvents: eventsList,
        get events() {
            return this.m_rgEvents.filter((e: any) => e.BIsValid());
        },
        BHasEvents() {
            return this.events.length > 0;
        },
        get isValid() {
            return this.events.length > 0;
        },
        GetLatestEventTime() {
            return this.m_rgEvents.length
                ? this.m_rgEvents[0].rtEventTime
                : this.m_rtDayBegin;
        },
        GetEarliestEventTime() {
            return this.m_rgEvents.length
                ? this.m_rgEvents[this.m_rgEvents.length - 1].rtEventTime
                : this.m_rtDayBegin;
        },
        SortEvents() {
            this.m_rgEvents.sort(
                (a: any, b: any) => (b.rtEventTime ?? 0) - (a.rtEventTime ?? 0),
            );
        },
        AddEvent(e: any) {
            this.m_rgEvents.push(e);
        },
    };
}

/**
 * The Per-Day Activity Feed API.
 *
 * Like the Post-Game Summary, we never hand-roll activity DOM. Steam already has
 * `ActivityFeedContainer`, `AppActivityDay` and `EventHeadline` (module 80478), and renders them in:
 *   - Desktop: via the `activity` section in LeftColumn (surfaces/sections)
 *   - Big Picture: via `ae.W` in the native "ACTIVITY" tab
 *
 * For non-Steam games, Steam hides the section by app type and skips activity
 * queries. Upstream event renderers guard on `StoreItemCache.GetStoreItemWithLegacyVisibilityCheck`,
 * so a lightweight in-memory StoreItem stub (zero network requests) lets Steam's genuine
 * components render a shortcut's feed: its achievements, "Added to library", "Played for the
 * first time" and, for a mapped game, the native app's news and friend events.
 *
 * The screenshots and recordings Steam captured are not published here: the separate
 * `steam-captured-activity` plugin adds them to the same feed, for Steam games and shortcuts
 * alike (docs/steam-captured-activity.md). Each plugin keeps its own events; this one sets a new
 * entry on change and that plugin merges its captures into it.
 */

/** Apps with fake in-memory StoreItems injected into StoreItemCache. */
const injectedStoreApps = new Set<number>();

/**
 * Shortcut appid -> native appid whose Steam activity (partner events / news,
 * friend events) joins the shortcut's feed (parity plan D). Set by the Steam
 * Store bucket for mapped games only.
 */
const nativeActivitySource = new Map<number, number>();

export function setNativeActivitySource(appid: number, nativeAppid: number | undefined): void {
    if (nativeAppid === undefined) nativeActivitySource.delete(appid);
    else nativeActivitySource.set(appid, nativeAppid);
}

/**
 * Shortcut appid -> its achievements (the record's part, ADR-0056): every unlock with a time becomes Steam's own
 * "achieved" event on its day, whatever the source (emulator saves, trophy files, RetroAchievements, Epic, Xbox).
 */
const achievementSource = new Map<number, AchievementSet>();

export function setAchievementSource(appid: number, set: AchievementSet | undefined): void {
    if (set) achievementSource.set(appid, set);
    else achievementSource.delete(appid);
}

/** What the feed last published per app, so an unchanged feed writes nothing (guardrail 17.2). */
const publishedSignature = new Map<number, string>();

/**
 * One day's unlocks as Steam's achievement event: P's fields (module 12750) on the shared event base. One event per
 * day, as Steam groups a user's unlocks of a day (`AddAchievementEvent`), timed at the day's newest unlock.
 */
function achievementEvent(appid: number, day: ActivityAchievementDay, actor: unknown): any {
    const base = activityEventBase();
    const ev = Object.create(base ?? Object.prototype);
    ev.gameid = appid.toString();
    Object.defineProperty(ev, "appid", { get: () => appid, configurable: true });
    ev.unUniqueID = `ach_${appid}_${day.day}`;
    ev.rtEventTime = day.latest;
    ev.steamIDActor = actor;
    ev.steamIDTarget = actor;
    ev.eEventType = 2; // AchievementUnlocked
    ev.bIsGameActivity = false;
    ev.bIsNonSteam = true;
    ev.commentThreads = [];
    ev.activeThread = 0;
    ev.m_rtOldestAchievement = day.oldest;
    ev.m_rgAchievements = day.items.map((i) => ({
        strID: i.id,
        strName: i.name,
        strDescription: i.description,
        strImage: i.icon,
        flAchieved: i.globalPct,
        rtUnlocked: i.unlockedAt,
        bAchieved: true,
    }));
    Object.defineProperty(ev, "achievements", { get() { return this.m_rgAchievements; }, configurable: true });
    ev.BIsValid = () => true;
    ev.GetParentalFeature = () => 0;
    ev.BSupportsCommentThreads = () => false;
    ev.BUserCanDelete = () => false;
    ev.GetActiveCommentThread = () => null;
    return ev;
}

/**
 * Steam's own activity for a native app, as [day key, day] pairs. `GetAppActivity`
 * makes Steam restore its cache and fetch from the server (verified live
 * 2026-09-25: unowned 2820820 returned one partner event, type 1002). A native
 * day's `m_rtDayBegin` is unset, so the key comes from `m_mapActivityByDay`.
 * Polls until Steam stops loading, at most 8 s.
 */
async function nativeActivityDays(nativeAppid: number | undefined): Promise<[number, AppActivityDay][]> {
    const store = appActivityStore() as (AppActivityStore & { m_setAppsLoading?: Set<number>; m_setAppFetchRequested?: Set<number> }) | undefined;
    if (nativeAppid === undefined || !store) return [];
    for (let i = 0; i < 16; i++) {
        const entry = store.GetAppActivity(nativeAppid);
        const busy = store.m_setAppsLoading?.has(nativeAppid) || store.m_setAppFetchRequested?.has(nativeAppid);
        if (entry && !busy) return [...entry.m_mapActivityByDay.entries()];
        await new Promise((r) => setTimeout(r, 500));
    }
    const entry = store.m_mapAppActivity.get(nativeAppid);
    return entry ? [...entry.m_mapActivityByDay.entries()] : [];
}

/** Compute local midnight in unix seconds for a given timestamp. */
function getLocalMidnight(timestamp: number): number {
    const d = new Date(timestamp * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

let isStoreCacheHooked = false;

/**
 * Hook StoreItemCache.prototype.BIsAppMissing to ensure non-Steam shortcut appids
 * (>= 0x8000_0000) are never treated as missing/unavailable store items.
 *
 * This provides permanent immunity against negative-cache poisoning
 * (StoreItemCache.m_setUnavailableApps) caused by asynchronous React unmount hooks
 * issuing 404 store requests when navigating between shortcuts and native games.
 */
export function ensureStoreCacheHooked(): boolean {
    if (isStoreCacheHooked) return true;
    const storeCache = storeItemCache();
    if (!storeCache) return false;

    const proto = Object.getPrototypeOf(storeCache);
    if (!proto || typeof proto.BIsAppMissing !== "function") return false;

    isStoreCacheHooked = true;
    const origBIsAppMissing = proto.BIsAppMissing;

    proto.BIsAppMissing = function (appid: number) {
        if (!deps.isEnabled("store-cache")) return origBIsAppMissing.apply(this, arguments);
        try {
            if (typeof appid === "number" && isShortcutAppId(appid)) {
                return false;
            }
        } catch (err) {
            deps.reportError("store-cache", err); // fail-open (plan § 7.0 D6)
        }
        return origBIsAppMissing.apply(this, arguments);
    };
    logger.info("Installed StoreItemCache.BIsAppMissing shortcut immunity hook.");
    return true;
}

/**
 * When the player first had and first played a shortcut, for the synthetic "Added to library" and "Played for the
 * first time" events: remembered once found (localStorage), else estimated from the earliest capture and the play
 * time Steam keeps. Captures are only read for the estimate, the first time.
 */
async function playTimeline(
    appid: number,
    gameid: string,
    overview: any,
    showFirstPlayed: boolean,
): Promise<{ addedTime: number; firstPlayedTime?: number; hasPlayEvidence: boolean }> {
    const stored = getActivityTimestamps(appid);
    const playedSteam = (overview?.minutes_playtime_forever ?? 0) > 0 || (overview?.rt_last_time_played ?? 0) > 0;
    let earliestMedia: number | undefined;
    if (!stored.addedToLibrary || (showFirstPlayed && !stored.firstPlayed)) {
        const [screenshots, clips] = await Promise.all([screenshotsSince(appid, 0), clipsSince(gameid, 0)]);
        const times = [...screenshots.map((s) => s.nCreated), ...clips.map((c) => c.date_clipped || c.date_recorded)].filter((t) => t > 0);
        if (times.length > 0) earliestMedia = Math.min(...times);
    }
    const now = Math.floor(Date.now() / 1000);

    let addedTime = stored.addedToLibrary;
    if (!addedTime) {
        if (earliestMedia) addedTime = earliestMedia - 3600;
        else if (overview?.rt_last_time_played > 0) addedTime = overview.rt_last_time_played - 3600;
        else addedTime = now;
        saveActivityTimestamps(appid, { addedToLibrary: addedTime });
    }

    const hasPlayEvidence = playedSteam || earliestMedia !== undefined || !!stored.firstPlayed;
    let firstPlayedTime = stored.firstPlayed;
    if (hasPlayEvidence && !firstPlayedTime) {
        if (overview?.rt_last_time_played > 0) {
            const playtimeSec = (overview.minutes_playtime_forever || 1) * 60;
            firstPlayedTime = overview.rt_last_time_played - playtimeSec;
            if (earliestMedia && earliestMedia < firstPlayedTime) firstPlayedTime = earliestMedia;
        } else if (earliestMedia) {
            firstPlayedTime = earliestMedia;
        } else {
            firstPlayedTime = addedTime + 60;
        }
        if (firstPlayedTime < addedTime) {
            addedTime = firstPlayedTime - 3600;
            saveActivityTimestamps(appid, { addedToLibrary: addedTime });
        }
        saveActivityTimestamps(appid, { firstPlayed: firstPlayedTime });
    }
    return { addedTime, firstPlayedTime, hasPlayEvidence };
}

/** One of Steam's simple activity events (3 ReceivedNewGame, 30 PlayedGameFirstTime) on the screenshot event class. */
function simpleEvent(V: any, appid: number, type: 3 | 30, id: string, time: number, actor: unknown): any {
    const ev = Object.create(V ? V.prototype : Object.prototype);
    ev.eEventType = type;
    ev.gameid = appid.toString();
    Object.defineProperty(ev, "appid", { get: () => appid, configurable: true });
    ev.unUniqueID = id;
    ev.rtEventTime = time;
    ev.steamIDActor = actor;
    ev.steamIDTarget = actor;
    ev.bIsGameActivity = false;
    ev.bIsNonSteam = true;
    ev.BIsValid = () => true;
    if (type === 3) ev.GetFilteredAppIds = () => [appid];
    else ev.BIsApplicationOrTool = () => false;
    ev.commentThreads = [];
    ev.activeThread = 0;
    ev.GetActiveCommentThread = () => null;
    ev.GetParentalFeature = () => 0;
    ev.BSupportsCommentThreads = () => false;
    ev.BUserCanDelete = () => false;
    return ev;
}

/**
 * Publish a shortcut's Activity Feed: achievements per day, the synthetic "Added to library" and "Played for the
 * first time" events, and a mapped game's native news and friend events. Shortcuts only (publish.ts checks).
 *
 * Returns the number of events published.
 */
export async function publishActivity(appid: number, gameid: string): Promise<number> {
    const { showAdded, showFirstPlayed, showAchievements } = deps.activityOptions();

    const nativeDays = await nativeActivityDays(nativeActivitySource.get(appid));
    const achDays = showAchievements ? achievementDays(achievementSource.get(appid), getLocalMidnight) : [];
    if (nativeDays.length === 0 && achDays.length === 0 && !showAdded && !showFirstPlayed) return 0;

    const actStore = appActivityStore();
    const storeCache = storeItemCache();
    const currentSteamID = friendStore()?.currentUserSteamID;

    if (!actStore || !storeCache || !currentSteamID) {
        logger.warn("Activity feed stores or SteamID not available for", appid);
        return 0;
    }

    const overview = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
    const displayName = overview?.display_name || "";
    const iconUrl = getCommunityIconUrl(appid, overview);

    // Guarantee that any past negative-cache blacklist entry is purged
    if (storeCache.m_setUnavailableApps?.has(appid)) {
        storeCache.m_setUnavailableApps.delete(appid);
    }
    ensureStoreCacheHooked();

    // 1. Ensure fake StoreItem exists in StoreItemCache so dt's visibility guard passes
    let fakeApp = storeCache.m_mapApps.get(appid);
    if (!fakeApp) {
        const sampleApp = storeCache.m_mapApps.values().next().value;
        fakeApp = Object.create(sampleApp ? Object.getPrototypeOf(sampleApp) : Object.prototype);
        fakeApp.m_unID = fakeApp.m_unAppID = appid;
        fakeApp.m_bVisible = true;
        fakeApp.m_strName = displayName;
        fakeApp.m_eItemType = 0;
        fakeApp.m_eAppType = 1;
        fakeApp.m_rgStoreTags = [];
        fakeApp.m_rgStoreTagIDs = [];
        fakeApp.m_DataRequested = {
            include_assets: true,
            include_platforms: true,
            include_release: true,
            include_tag_count: 0,
        };
        fakeApp.BIsVisible = () => true;
        fakeApp.BIsApplicationOrTool = () => false;
        fakeApp.BContainDataRequest = () => true;

        storeCache.m_mapApps.set(appid, fakeApp);
        injectedStoreApps.add(appid);
    }
    fakeApp.GetName = () => displayName;
    fakeApp.GetAssets = () => ({ GetCommunityIconURL: () => iconUrl });

    // 2. Resolve event class constructor
    const V = screenshotEventClass();

    // 3. A new CAppActivity on every publish (ADR-0056): Steam's feed keeps the object it mounted with and re-renders
    // when the store's observable map is given a new object for the app, not when the old one is mutated (verified live
    // 2026-10-02: unlocks that arrive after the page opened showed up within 2 s). It is set at the end, once full.
    // The constructor sample must be Steam's own class: never a plain object (our fallback literal).
    const sampleEntry = [...actStore.m_mapAppActivity.values()].find(
        (e) => e?.m_mapActivityByDay instanceof Map && e.constructor !== Object,
    ) as AppActivity | undefined;
    const CAppActivity = sampleEntry?.constructor as (new (appid: number) => AppActivity) | undefined;

    let appActivity: AppActivity;
    if (CAppActivity) {
        appActivity = new CAppActivity(appid);
    } else {
        // No Steam-made entry to borrow the class from (common right after start-up). Steam's activity store
        // reads these fields from any entry (FetchLatestActivityFromServer / FetchActivityHistory build protobuf
        // requests from them); without them `undefined + 1` is NaN and jspb's writeUint32 throws "Assertion
        // failed" (found live 2026-10-06). Same initial values as Steam's CAppActivity.
        appActivity = {
            m_unAppID: appid,
            m_rtEarliestUserNewsTime: 4294967295,
            m_rtEarliestGameActivityTime: 4294967295,
            m_rtLatestUserNewsTime: 0,
            m_rtLatestGameActivityTime: 0,
            m_rgCachedUserNewsEvents: [],
            m_rgCachedGameActivityEvents: [],
            get earliest_user_news_time() { return this.m_rtEarliestUserNewsTime; },
            get earliest_game_activity_time() { return this.m_rtEarliestGameActivityTime; },
            get latest_user_news_time() { return this.m_rtLatestUserNewsTime; },
            get latest_game_activity_time() { return this.m_rtLatestGameActivityTime; },
            // A fetch Steam queued before this entry existed (RestoreActivity) still runs against it: the merge and
            // cache steps CAppActivity has, as no-ops (a shortcut has no server news; the next publish rebuilds the feed).
            async MergeUserNews() {},
            MergeGameActivity() {},
            GetAchievementMapCache: () => "[]",
            GetUserNewsCache: () => [],
            GetGameActivityCache: () => [],
            m_mapActivityByDay: new Map(),
            get lastAddedEventType() {
                const first = this.appActivityByDay?.[0];
                return first && first.events.length > 0 ? first.events[0].eEventType : 0;
            },
            get lastAddedPartnerEvent() {
                return null;
            },
            BHasEvents() {
                return this.appActivityByDay.length > 0;
            },
            get appActivityByDay() {
                return Array.from(this.m_mapActivityByDay.keys())
                    .sort((a, b) => b - a)
                    .map((k) => this.m_mapActivityByDay.get(k)!)
                    .filter((d) => d && d.BHasEvents());
            },
        };
    }
    // A shortcut has no activity on Steam's servers: the feed's "show more" must not ask for history (it would send
    // a request for an appid the server does not know).
    appActivity.m_bNoMoreHistoryAvailable = true;
    appActivity.m_mapActivityByDay.clear();

    const getOrCreateDay = (dayBegin: number): AppActivityDay => {
        let day = appActivity.m_mapActivityByDay.get(dayBegin);
        if (!day) {
            day = createActivityDay(dayBegin);
            appActivity.m_mapActivityByDay.set(dayBegin, day);
        }
        if (!Array.isArray(day.m_rgEvents)) day.m_rgEvents = [];
        return day;
    };

    // 4. Native news and friend events for a mapped shortcut (parity plan D): Steam's
    // own event objects, added to the same local day as the rest.
    let nativeEvents = 0;
    for (const [nativeKey, nativeDay] of nativeDays) {
        const day = getOrCreateDay(getLocalMidnight(nativeKey));
        for (const event of [...(nativeDay.m_rgEvents ?? [])]) {
            day.m_rgEvents.push(event);
            nativeEvents++;
        }
    }

    // 5. Achievements (ADR-0056): one "achieved" event per day with unlocks, from the record's part.
    for (const d of achDays) {
        getOrCreateDay(d.day).m_rgEvents.push(achievementEvent(appid, d, currentSteamID));
    }
    const achievementCount = achDays.reduce((n, d) => n + d.items.length, 0);

    // 6. Synthetic native activity events: Added to Library and Played First Time
    let syntheticCount = 0;
    if (showAdded || showFirstPlayed) {
        const { addedTime, firstPlayedTime, hasPlayEvidence } = await playTimeline(appid, gameid, overview, showFirstPlayed);
        if (showAdded && addedTime) {
            getOrCreateDay(getLocalMidnight(addedTime)).m_rgEvents.push(
                simpleEvent(V, appid, 3, `added_${appid}_${addedTime}`, addedTime, currentSteamID),
            );
            syntheticCount++;
        }
        if (showFirstPlayed && hasPlayEvidence && firstPlayedTime) {
            getOrCreateDay(getLocalMidnight(firstPlayedTime)).m_rgEvents.push(
                simpleEvent(V, appid, 30, `played_${appid}_${firstPlayedTime}`, firstPlayedTime, currentSteamID),
            );
            syntheticCount++;
        }
    }

    // Sort events in each day chronologically descending
    for (const day of appActivity.m_mapActivityByDay.values()) {
        if (Array.isArray(day.m_rgEvents)) {
            day.m_rgEvents.sort((a: any, b: any) => (b.rtEventTime ?? 0) - (a.rtEventTime ?? 0));
        }
    }

    // Hand Steam the new object only when the feed changed (guardrail 17.2): same native events, unlocks and
    // synthetic events -> nothing is written, nothing re-renders.
    const signature = JSON.stringify([
        nativeDays.map(([k, d]) => [k, (d.m_rgEvents ?? []).length]),
        achDays.map((d) => [d.day, d.items.map((i) => `${i.id}:${i.unlockedAt}`)]),
        [...appActivity.m_mapActivityByDay.values()].map((d) => (d.m_rgEvents ?? []).map((e: any) => `${e.eEventType}:${e.rtEventTime}`)),
    ]);
    const previous = actStore.m_mapAppActivity.get(appid);
    if (publishedSignature.get(appid) !== signature || !(previous?.m_mapActivityByDay instanceof Map)) {
        actStore.m_mapAppActivity.set(appid, appActivity);
        publishedSignature.set(appid, signature);
    }
    actStore.m_setAppFetchRequested?.add(appid);
    logger.info(
        `Published ${nativeEvents} native event(s), ${achievementCount} unlock(s) on ${achDays.length} day(s), and ${syntheticCount} synthetic activity event(s) across ${appActivity.m_mapActivityByDay.size} day(s) in activity feed for ${appid}.`,
    );
    return nativeEvents + achievementCount + syntheticCount;
}

/** Drop a shortcut's activity feed entry. */
export function clearActivity(appid: number): void {
    publishedSignature.delete(appid);
    const actStore = appActivityStore();
    if (actStore) {
        actStore.m_mapAppActivity.delete(appid);
    }

    // Retain in-memory stub in StoreItemCache.m_mapApps!
    // In-memory stubs consume negligible RAM (~150 bytes) and must persist indefinitely.
    // Deleting them triggers asynchronous 404 store requests from unmounting hooks,
    // permanently blacklisting the appid in StoreItemCache.m_setUnavailableApps.
    injectedStoreApps.delete(appid);
}
