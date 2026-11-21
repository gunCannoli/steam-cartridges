// Surface `captures`: which shortcut pages are open (publish.ts writes it, the screenshot trail reads it). Its own module so
// the two do not import each other.

/**
 * Shortcuts whose page is open (between shortcut.viewed and shortcut.left). A record change re-publishes only these
 * (`onRecordChanged`): the start-up achievements preload updates every shortcut's record, and publishing all of them
 * sent ~450 `GetClips` calls to Steam's recording service within seconds of every start, after which Steam listed no
 * clips at all for the session, its own media view included (found 2026-10-07; with this part off, all 8 came back).
 */
export const viewing = new Set<number>();

/** Is this shortcut's page open now? */
export function isViewing(appid: number): boolean {
    return viewing.has(appid);
}
