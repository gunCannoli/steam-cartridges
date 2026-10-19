import { logger } from "../../logger";
import { clearActivity, publishActivity } from "./activity";
import { toGameId, toShortcutId, type ShortcutId } from "../../kernel/appid";
import { clearSummary, publishSummary } from "./summary";
import { deps } from "./deps";

/**
 * Brings the native app detail sections to a non-Steam game's page.
 *
 * There is no markup here, and no DOM surgery, on purpose. Steam already has
 * the components; it just hides them from shortcuts and never loads their data.
 * So we do exactly two things:
 *
 *   1. put the section names back into Steam's registry (surfaces/sections)
 *   2. put events into Steam's own stores           (summary.ts & activity.ts)
 *
 * Steam renders. That is the whole renderer.
 *
 * This replaces ~800 lines of hand-built components that reproduced Steam's
 * summary markup, carousel, day grouping and hover states. Every one of those
 * was a thing that could drift from native on the next Steam update; none of
 * them can any more. See docs/steam-components.md.
 */

/** Apps whose summary or activity we have published, so a quitting game can refresh them. */
const published = new Set<number>();

/**
 * Shortcuts whose page is open (between shortcut.viewed and shortcut.left). A record change re-publishes only these
 * (`onRecordChanged`): the start-up achievements preload updates every shortcut's record, and publishing all of them
 * sent ~450 `GetClips` calls to Steam's recording service within seconds of every start, after which Steam listed no
 * clips at all for the session, its own media view included (found 2026-10-07; with this part off, all 8 came back).
 */
const viewing = new Set<number>();

/** Report whether an app has content (`captures.published`; the sections surface drops its placeholder, M10). */
function setHasContent(appid: number, hasContent: boolean): void {
    deps.bus.emit("captures.published", { appid: appid as ShortcutId, hasContent });
}

/**
 * Publish a shortcut's summary and activity feed so Steam's own sections can render them.
 *
 * Shortcuts only: a Steam game has its own summary and feed (its captures in the feed come from the
 * steam-captured-activity plugin). The caller owns that check because it also decides when to clear.
 */
export async function patch(appid: number): Promise<void> {
    const id = toShortcutId(appid);
    if (id === undefined) return;
    viewing.add(appid);
    const gameid = toGameId(id);

    try {
        const [summaryCount, activityCount] = await Promise.all([
            publishSummary(appid, gameid),
            publishActivity(appid, gameid),
        ]);
        const totalCount = summaryCount + activityCount;
        if (totalCount > 0) published.add(appid);

        // Steam's "information is unavailable" placeholder is only worth removing
        // once we have something to show instead.
        setHasContent(appid, totalCount > 0);
    } catch (error) {
        logger.error("Could not publish summary or activity for", appid, error);
    }
}

/** Re-read captures for an app (called when a game quits). */
export async function refresh(appid: number): Promise<void> {
    if (!published.has(appid)) return;
    await patch(appid);
}

/** Forget an app's summary and activity feed. */
/** A record part changed (the surface's render): re-publish only a shortcut whose page is open. */
export function onRecordChanged(appid: number): void {
    if (viewing.has(appid)) void patch(appid);
}

export function unpatch(appid: number): void {
    viewing.delete(appid);
    if (!published.delete(appid)) return;
    setHasContent(appid, false);
    clearSummary(appid);
    clearActivity(appid);
}

