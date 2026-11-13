// Surface `feed`: the only code that writes Steam's activity store (`appActivityStore.m_mapAppActivity`) and the
// workshop records the feed's screenshot events point at. It adds one "captured" event (Steam's own screenshot event
// class, type 13) per day with captures to the app's feed, next to whatever else is there: Steam's news and friend
// events for a Steam game, steam-cartridges' events (achievements, added to library) for a shortcut.
//
// Several writers share one entry per app, and none may depend on another:
//   - Steam fills a Steam game's entry in place from its server fetch.
//   - steam-cartridges sets a brand-new entry for a shortcut on each change (its activity.ts), dropping whatever the
//     old one held.
// So the events are not "owned" by an entry: the surface keeps what each app should show (`desired`) and merges it
// into the entry it finds, and into any entry another writer sets later (the `set` wrapper below). Every event and
// day it adds carries MARK, so a later publish or a clear takes back exactly its own and nothing else.
import { logger } from "../../logger";
import { isShortcutAppId, toUnsigned } from "../../kernel/appid";
import { signature, type CaptureDay } from "../../kernel/captures";
import {
    appActivityStore,
    friendStore,
    screenshotEventClass,
    type AppActivity,
    type AppActivityDay,
    type AppActivityStore,
} from "../../steam/stores";
import { workshopStore } from "../../steam/captures";

/** Steam's `CSteamID` shape (the event actor). */
interface SteamID {
    ConvertTo64BitString(): string;
}
import { safety } from "./context";
import { ensureShortcutStoreItem } from "./stub";

/** On every event and day this surface adds: how strip() finds its own. */
const MARK = "__capturedActivity";

/** What each app's feed should show, and its signature. */
const desired = new Map<number, { days: CaptureDay[]; sig: string }>();
/** Workshop record ids registered per app, for removal. */
const filesByApp = new Map<number, string[]>();
/** Entries this surface built because the app had none (nobody else writes to them). */
const ownEntries = new WeakSet<object>();
/** The signature last merged into an entry: the same one again writes nothing (guardrail 17.2). */
const mergedSig = new WeakMap<object, string>();

/** The activity map whose `set` is wrapped, and its original `set` / `delete`. */
let wrapped: { map: Map<number, AppActivity>; set: Map<number, AppActivity>["set"]; del: Map<number, AppActivity>["delete"] } | undefined;
/** True while this surface itself writes the map: the wrapper must not merge into our own write. */
let writing = false;

function eventsOf(day: AppActivityDay): any[] {
    const e = day.m_rgEvents;
    if (Array.isArray(e)) return [...e];
    return e && typeof e[Symbol.iterator] === "function" ? [...e] : [];
}

function setEvents(day: AppActivityDay, list: any[]): void {
    list.sort((a, b) => (b?.rtEventTime ?? 0) - (a?.rtEventTime ?? 0));
    day.m_rgEvents = list;
}

/** A day object like Steam's CAppActivityDay (same fields steam-cartridges' activity.ts builds). */
function newDay(dayBegin: number): AppActivityDay {
    return {
        [MARK]: true,
        m_rtDayBegin: dayBegin,
        get dayBegin() {
            return this.m_rtDayBegin;
        },
        m_rgEvents: [] as any[],
        // Steam 1794424036 (2026-11) walks every day's `allEvents` (GetActivityCache, LoadDetails) and its events dropped
        // BIsValid for BCanRender: answer both, never call a method an event may lack.
        get allEvents() {
            return this.m_rgEvents;
        },
        get events() {
            return (this.m_rgEvents as any[]).filter((e: any) => {
                try {
                    if (typeof e?.BCanRender === "function") return !!e.BCanRender();
                    return e?.BIsValid?.() !== false;
                } catch {
                    return false;
                }
            });
        },
        BHasEvents() {
            return (this.events ?? []).length > 0;
        },
        get isValid() {
            return (this.events ?? []).length > 0;
        },
        GetLatestEventTime() {
            return this.m_rgEvents[0]?.rtEventTime ?? this.m_rtDayBegin;
        },
        GetEarliestEventTime() {
            return this.m_rgEvents[this.m_rgEvents.length - 1]?.rtEventTime ?? this.m_rtDayBegin;
        },
        SortEvents() {
            setEvents(this as AppActivityDay, eventsOf(this as AppActivityDay));
        },
        AddEvent(e: any) {
            this.m_rgEvents.push(e);
        },
    } as AppActivityDay;
}

/** One day's captures as Steam's own screenshot event (type 13, FilePublished_Screenshot), with the cards' items. */
function captureEvent(appid: number, day: CaptureDay, actor: SteamID, V: any): any {
    const ids = day.items.map((i) => i.id);
    const ev = Object.create(V ? V.prototype : Object.prototype);
    ev[MARK] = true;
    ev.m_rgScreenshots = ids;
    ev.m_bIsValid = true;
    // A newer Steam (beta 1794022194) asks `screenshots.length > 0` in BCanRender(); the ids here carry no `preview`, so the card
    // would be hidden (or, with no list, throw). Ours is always shown.
    ev.BCanRender = () => true;
    ev.unUniqueID = ids[0];
    ev.rtEventTime = day.items[0]?.timestamp ?? day.day;
    ev.steamIDActor = actor;
    ev.steamIDTarget = actor;
    ev.eEventType = 13;
    ev.bIsGameActivity = false;
    ev.bIsNonSteam = isShortcutAppId(appid);
    ev.m_mediaItems = day.items;
    ev.commentThreads = [];
    ev.activeThread = 0;
    // The base class derives appid as Number(this.gameid), which overflows for a shortcut's 64-bit id.
    ev.gameid = String(appid);
    Object.defineProperty(ev, "appid", { get: () => appid, configurable: true });
    ev.BIsValid = () => true;
    // Steam 1794424036 calls these on every event of an entry (SaveActivity -> GetActivityCache, LoadDetails): no cache
    // entries (Steam never stores our cards), nothing to load.
    ev.GetCacheEntries = () => [];
    ev.LoadDetails = async () => false;
    ev.GetCurrentPublishedFileID = () => ids[ev.activeThread || 0] || ids[0];
    ev.SetActiveCommentThread = (i: number) => {
        ev.activeThread = i;
    };
    ev.GetActiveCommentThread = () => null;
    ev.GetParentalFeature = () => 0;
    ev.BSupportsCommentThreads = () => false;
    ev.BUserCanDelete = () => false;
    return ev;
}

/** Steam's CAppActivity class, borrowed from an entry Steam made (never one of our plain fallbacks). */
// Kept for the session once seen: Steam's entries can be gone later, and its own class has every method its store calls
// (the plain fallback below is a copy, which a Steam update outruns: GetNewestActivityTime on the 2026-11 beta).
let seenClass: (new (appid: number) => AppActivity) | undefined;
function activityClass(store: AppActivityStore): (new (appid: number) => AppActivity) | undefined {
    for (const e of store.m_mapAppActivity.values()) {
        if (e?.m_mapActivityByDay instanceof Map && (e as object).constructor !== Object) {
            seenClass = (e as object).constructor as new (appid: number) => AppActivity;
            return seenClass;
        }
    }
    return seenClass;
}

/**
 * A new, empty entry for an app Steam has none for. Steam's own class when one can be borrowed; otherwise a plain
 * object with the fields Steam's store reads from any entry (FetchLatestActivityFromServer builds protobuf requests
 * from them: without them jspb throws "Assertion failed", found live 2026-10-06 in steam-cartridges).
 */
function newEntry(store: AppActivityStore, appid: number): AppActivity {
    const C = activityClass(store);
    const entry: any = C
        ? new C(appid)
        : {
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
              async MergeUserNews() {},
              MergeGameActivity() {},
              GetNewestActivityTime() { return Math.max(this.m_rtLatestUserNewsTime, this.m_rtLatestGameActivityTime); },
              GetAchievementMapCache: () => "[]",
              GetUserNewsCache: () => [],
              GetGameActivityCache: () => [],
              m_mapActivityByDay: new Map(),
              get lastAddedEventType() { return this.appActivityByDay?.[0]?.events?.[0]?.eEventType ?? 0; },
              get lastAddedPartnerEvent() { return null; },
              BHasEvents() { return this.appActivityByDay.length > 0; },
              get appActivityByDay() {
                  return [...this.m_mapActivityByDay.keys()]
                      .sort((a: number, b: number) => b - a)
                      .map((k: number) => this.m_mapActivityByDay.get(k))
                      .filter((d: any) => d?.BHasEvents?.());
              },
          };
    // A shortcut has no activity on Steam's servers: "show more" must not ask for history it does not know.
    if (isShortcutAppId(appid)) entry.m_bNoMoreHistoryAvailable = true;
    ownEntries.add(entry);
    return entry as AppActivity;
}

/** Take this surface's events (and its days left empty) out of an entry. Returns the day keys it touched. */
function strip(entry: AppActivity): Set<number> {
    const touched = new Set<number>();
    for (const [key, day] of [...entry.m_mapActivityByDay.entries()]) {
        const events = eventsOf(day);
        const kept = events.filter((e) => !e?.[MARK]);
        if (kept.length === events.length) continue;
        touched.add(key);
        if (kept.length === 0 && (day as any)[MARK]) entry.m_mapActivityByDay.delete(key);
        else setEvents(day, kept);
    }
    return touched;
}

/** Put an app's desired days into an entry (after strip). Returns the day keys it touched. */
function apply(entry: AppActivity, appid: number, days: readonly CaptureDay[], actor: SteamID): Set<number> {
    const touched = new Set<number>();
    const V = screenshotEventClass();
    for (const d of days) {
        let day = entry.m_mapActivityByDay.get(d.day);
        if (!day) {
            day = newDay(d.day);
            entry.m_mapActivityByDay.set(d.day, day);
        }
        setEvents(day, [...eventsOf(day), captureEvent(appid, d, actor, V)]);
        touched.add(d.day);
    }
    return touched;
}

/** Bring an entry to the desired state. Returns whether it changed. */
function merge(entry: AppActivity, appid: number, actor: SteamID): boolean {
    const want = desired.get(appid);
    const sig = want?.sig ?? "";
    if ((mergedSig.get(entry) ?? "") === sig) return false;
    strip(entry);
    if (want) apply(entry, appid, want.days, actor);
    mergedSig.set(entry, sig);
    return true;
}

/** Write through the map's own methods, never through the wrapper's merge. */
function write(fn: () => void): void {
    writing = true;
    try {
        fn();
    } finally {
        writing = false;
    }
}

/**
 * Make Steam re-render an entry it already holds. Steam's feed re-renders when the store's map changes, not when an
 * entry is mutated (steam-cartridges, verified live 2026-10-02), so the entry is taken out and put back: Steam's own
 * object stays, with its fetch state.
 */
function nudge(store: AppActivityStore, appid: number, entry: AppActivity): void {
    const set = wrapped?.set ?? store.m_mapAppActivity.set;
    const del = wrapped?.del ?? store.m_mapAppActivity.delete;
    write(() => {
        del.call(store.m_mapAppActivity, appid);
        set.call(store.m_mapAppActivity, appid, entry);
    });
}

/**
 * Wrap the activity map's `set`, once per map: an entry another writer sets for an app with captures gets the
 * captures merged in before Steam sees it. O(1) when the app has none (one Map lookup); fail-open.
 */
function adopt(store: AppActivityStore): void {
    const map = store.m_mapAppActivity;
    if (!map || wrapped?.map === map) return;
    const set = map.set;
    const del = map.delete;
    const actorOf = () => friendStore()?.currentUserSteamID;
    map.set = function (this: Map<number, AppActivity>, key: number, value: AppActivity) {
        if (!writing && safety.isEnabled("feed")) {
            try {
                const appid = toUnsigned(key);
                const actor = actorOf();
                if (appid !== undefined && actor && desired.has(appid) && value?.m_mapActivityByDay instanceof Map && !ownEntries.has(value)) {
                    merge(value, appid, actor);
                }
            } catch (err) {
                safety.reportError("feed", err);
            }
        }
        return set.call(this, key, value);
    } as typeof map.set;
    wrapped = { map, set, del };
}

/** Register (and unregister) the workshop records the events' screenshot ids resolve to. */
function syncFiles(appid: number, days: readonly CaptureDay[], actor: SteamID): void {
    const ws = workshopStore();
    if (!ws) return;
    const ids: string[] = [];
    const creator = actor.ConvertTo64BitString();
    for (const d of days) {
        for (const item of d.items) {
            ids.push(item.id);
            ws.m_mapPublishedFiles.set(item.id, {
                file: {
                    publishedfileid: item.id,
                    file_url: item.url,
                    preview_url: item.url,
                    file_description: item.caption,
                    visibility: 0,
                    creator,
                    time_created: item.timestamp,
                    image_width: item.width,
                    image_height: item.height,
                },
            });
        }
    }
    const keep = new Set(ids);
    for (const old of filesByApp.get(appid) ?? []) if (!keep.has(old)) ws.m_mapPublishedFiles.delete(old);
    if (ids.length > 0) filesByApp.set(appid, ids);
    else filesByApp.delete(appid);
}

/**
 * Show an app's capture days in its feed (an empty list clears it). Idempotent: the same captures on the same entry
 * write nothing. Returns false when Steam's stores are not there yet (nothing was written).
 */
export function publish(appid: number, days: readonly CaptureDay[]): boolean {
    if (days.length === 0) {
        clear(appid);
        return true;
    }
    if (!safety.isEnabled("feed")) return false;
    try {
        const store = appActivityStore();
        const actor = friendStore()?.currentUserSteamID;
        if (!store?.m_mapAppActivity || !actor) {
            logger.warn("Activity store or Steam user not available yet for", appid);
            return false;
        }
        adopt(store);
        const shortcut = isShortcutAppId(appid);
        if (shortcut) ensureShortcutStoreItem(appid);

        const sig = signature(days);
        desired.set(appid, { days: [...days], sig });
        syncFiles(appid, days, actor);

        // A Steam game's entry is Steam's (GetAppActivity also starts its fetch); a shortcut's may be steam-cartridges'.
        let entry = store.m_mapAppActivity.get(appid) ?? (shortcut ? undefined : store.GetAppActivity(appid));
        if (entry && ownEntries.has(entry)) {
            // Ours alone: a fresh object, so Steam re-renders it (and a plain fallback is never mutated under Steam).
            if (mergedSig.get(entry) === sig) return true;
            entry = undefined;
        }
        if (!entry) {
            const fresh = newEntry(store, appid);
            merge(fresh, appid, actor);
            write(() => (wrapped?.set ?? store.m_mapAppActivity.set).call(store.m_mapAppActivity, appid, fresh));
        } else if (merge(entry, appid, actor)) {
            nudge(store, appid, entry);
        }
        // Steam must not ask its servers for a shortcut's activity (it would answer for an appid it does not know).
        if (shortcut) store.m_setAppFetchRequested?.add(appid);
        else afterFetch(appid);
        return true;
    } catch (err) {
        safety.reportError("feed", err);
        return false;
    }
}

/** Take an app's captures out of its feed and Steam's workshop store. Leaves every other event where it is. */
export function clear(appid: number): void {
    const had = desired.delete(appid);
    const store = appActivityStore();
    const actor = friendStore()?.currentUserSteamID;
    try {
        const ws = workshopStore();
        for (const id of filesByApp.get(appid) ?? []) ws?.m_mapPublishedFiles.delete(id);
        filesByApp.delete(appid);
        if (!had || !store?.m_mapAppActivity || !actor) return;
        const entry = store.m_mapAppActivity.get(appid);
        if (!entry) return;
        if (ownEntries.has(entry)) {
            // Nobody else has events here: the app goes back to having no entry.
            write(() => (wrapped?.del ?? store.m_mapAppActivity.delete).call(store.m_mapAppActivity, appid));
            return;
        }
        if (merge(entry, appid, actor)) nudge(store, appid, entry);
    } catch (err) {
        safety.reportError("feed", err);
    }
}

/** Apps whose feed currently shows captures. */
export function publishedApps(): number[] {
    return [...desired.keys()];
}

/** Does this app's feed show captures? O(1); the sections surface asks from inside Steam's render. */
export function hasCaptures(appid: number): boolean {
    return desired.has(appid);
}

/** How many of this surface's events an entry holds now. */
function ownEventCount(entry: AppActivity): number {
    let n = 0;
    for (const day of entry.m_mapActivityByDay.values()) for (const e of eventsOf(day)) if (e?.[MARK]) n++;
    return n;
}

/**
 * Is what an app should show missing from the entry Steam holds now? Another writer may have replaced the entry
 * unseen, or Steam's server fetch rebuilt its days in place (found live 2026-10-07: a Steam game's first view after
 * start-up lost its captures when the fetch landed), so this counts the events actually there.
 */
export function needsRepair(appid: number): boolean {
    const want = desired.get(appid);
    if (!want) return false;
    const entry = appActivityStore()?.m_mapAppActivity?.get(appid);
    return !entry || mergedSig.get(entry) !== want.sig || ownEventCount(entry) !== want.days.length;
}

/** Re-merge an app whose entry lost its captures (see needsRepair). */
function repair(appid: number): void {
    const store = appActivityStore();
    const actor = friendStore()?.currentUserSteamID;
    const entry = store?.m_mapAppActivity?.get(appid);
    if (!store || !actor || !entry || !desired.has(appid) || !needsRepair(appid)) return;
    mergedSig.delete(entry);
    if (merge(entry, appid, actor)) nudge(store, appid, entry);
}

/**
 * A Steam game's fetch still running after a publish rewrites the entry when it lands: watch it (every 500 ms, at most
 * 10 s) and put the captures back once it is done. Steam's `m_setAppsLoading` / `m_setAppFetchRequested` say it runs.
 */
function afterFetch(appid: number): void {
    let tries = 0;
    const tick = () => {
        const store = appActivityStore() as (AppActivityStore & { m_setAppsLoading?: Set<number> }) | undefined;
        const busy = !!store && (store.m_setAppsLoading?.has(appid) || store.m_setAppFetchRequested?.has(appid));
        if (!desired.has(appid) || !safety.isEnabled("feed")) return;
        try {
            repair(appid);
        } catch (err) {
            safety.reportError("feed", err);
        }
        if (busy && ++tries < 20) setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
}

/** For CDP checks: what the surface holds. */
export function feedDiagnostics(): { apps: Array<{ appid: number; days: number; captures: number }>; wrapped: boolean } {
    return {
        apps: [...desired.entries()].map(([appid, d]) => ({
            appid,
            days: d.days.length,
            captures: d.days.reduce((n, x) => n + x.items.length, 0),
        })),
        wrapped: !!wrapped,
    };
}
