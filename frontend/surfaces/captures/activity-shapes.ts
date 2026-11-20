// Pure (no imports): the tests load it directly.
//
// The day and event objects a shortcut's Activity feed is built from. Steam reads them with its own code, and each Steam
// build has asked for something new (2026-11, stable 1794424036: days need `allEvents`, events `GetCacheEntries` and
// `LoadDetails`, and Steam's events dropped `BIsValid`, which our old day filter called, so a Steam-linked shortcut's feed
// threw inside render: "An error occurred while rendering this content"). Rules that keep a future build from doing the same:
//  - prefer Steam's own day class (remembered from a day Steam made) over ours;
//  - our objects answer both the old and the new method names;
//  - never call a method an event may lack: `canRender` duck-types and catches.

/** Does Steam's feed show this event? Steam's own test is `BCanRender()`; older builds had `BIsValid()`. Never throws. */
export function canRender(e: any): boolean {
    try {
        if (!e) return false;
        if (typeof e.BCanRender === "function") return !!e.BCanRender();
        if (typeof e.BIsValid === "function") return !!e.BIsValid();
        return true;
    } catch {
        return false;
    }
}

/**
 * Give one of our events (synthetic or achievement) every method Steam's store calls on an event: `GetCacheEntries` empty
 * (Steam then never writes a shortcut's made-up events into its activity cache, and its "has no cache entries" assert is not
 * reached), `LoadDetails` with nothing to load, and both render tests.
 */
export function hardenEvent<T extends object>(ev: T): T {
    const e = ev as any;
    e.GetCacheEntries = () => [];
    e.LoadDetails = async () => false;
    if (typeof e.BCanRender !== "function") e.BCanRender = () => true;
    if (typeof e.BIsValid !== "function") e.BIsValid = () => true;
    return ev;
}

/** The `Add*Event` methods of Steam's day class (read live 2026-11-19), which our stand-in day answers as no-ops. */
export const STEAM_DAY_ADDERS = [
    "AddAchievementEvent",
    "AddPartnerEvent",
    "AddPlayedGameFirstTimeEvent",
    "AddReceivedGameEvent",
    "AddRecommendedGameEvent",
    "AddScreenshotEvent",
    "AddSteamTradingCardEvent",
    "AddUserStatusEvent",
    "AddVideoEvent",
    "AddWishlistedGameEvent",
] as const;

/** Our day, for when no Steam-made day has been seen yet: the shape of Steam's day class (2026-11) plus the old fields. */
export function standInDay(dayBegin: number): any {
    return {
        m_rtDayBegin: dayBegin,
        get dayBegin() {
            return this.m_rtDayBegin;
        },
        m_rgEvents: [] as any[],
        get allEvents() {
            return this.m_rgEvents;
        },
        get events() {
            return this.m_rgEvents.filter(canRender);
        },
        BHasEvents() {
            return this.events.length > 0;
        },
        get isValid() {
            return this.events.length > 0;
        },
        GetLatestEventTime() {
            return this.m_rgEvents.length ? this.m_rgEvents[0].rtEventTime : this.m_rtDayBegin;
        },
        GetEarliestEventTime() {
            return this.m_rgEvents.length ? this.m_rgEvents[this.m_rgEvents.length - 1].rtEventTime : this.m_rtDayBegin;
        },
        SortEvents() {
            this.m_rgEvents.sort((a: any, b: any) => (b?.rtEventTime ?? 0) - (a?.rtEventTime ?? 0));
        },
        AddEvent(e: any) {
            this.m_rgEvents.push(e);
        },
        // Steam's entry class calls these on a day when a server event is merged into the entry (AddUserNewsEvent ->
        // AddAchievementEvent, "is not a function" in a user's log 2026-11-19). A shortcut has no server events and the
        // feed is rebuilt by every publish, so they add nothing. The names are Steam's own day class's (read live).
        ...Object.fromEntries(STEAM_DAY_ADDERS.map((n) => [n, () => {}])),
    };
}

/**
 * One day of the feed, its events newest first. Steam's own day class when given (its constructor takes nothing; its event
 * list is a MobX array, filled through `AddEvent`), else our stand-in. Falls back to the stand-in if Steam's class throws.
 */
export function makeDay(DayClass: (new () => any) | undefined, dayBegin: number, events: any[]): any {
    const sorted = [...events].sort((a, b) => (b?.rtEventTime ?? 0) - (a?.rtEventTime ?? 0));
    let day: any;
    if (DayClass) {
        try {
            day = new DayClass();
            for (const e of sorted) day.AddEvent(e);
            if (!day.m_rtDayBegin) day.m_rtDayBegin = dayBegin;
            return day;
        } catch {
            /* fall through to ours */
        }
    }
    day = standInDay(dayBegin);
    for (const e of sorted) day.m_rgEvents.push(e);
    return day;
}

/** Is `d` a day as Steam's code reads it (2026-11)? Used to remember Steam's class and by the tests. */
export function looksLikeSteamDay(d: any): boolean {
    return !!d && typeof d.AddEvent === "function" && typeof d.BHasEvents === "function" && d.constructor !== Object;
}
