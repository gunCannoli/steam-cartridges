// Pure (no imports): the tests load it directly.

/** One of Steam's simple activity events (3 ReceivedNewGame, 30 PlayedGameFirstTime) on the screenshot event class. */
export function simpleEvent(V: any, appid: number, type: 3 | 30, id: string, time: number, actor: unknown): any {
    const ev = Object.create(V ? V.prototype : Object.prototype);
    // The class's constructor never ran, so its own state is missing. A newer Steam (beta 1794022194) answers BCanRender() with
    // `this.screenshots.length > 0`, and `screenshots` maps over `m_rgScreenshots`: undefined, so the whole Activity feed became
    // "An error occurred while rendering this content" (TypeError: Cannot read properties of undefined (reading 'map')). These two
    // event types are always worth showing, and an empty screenshot list keeps every other getter of the class safe.
    ev.m_rgScreenshots = [];
    ev.BCanRender = () => true;
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
