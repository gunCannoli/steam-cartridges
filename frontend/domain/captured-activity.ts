// Domain: what the Activity feed shows from an app's captures (the captured-activity feature, ported from the
// steam-captured-activity plugin 2026-11-12). Pure (type-only imports, `.ts` specifiers), so the
// unit tests run it with node. Steam's objects come in as plain data; nothing here touches Steam.
import { isShortcutAppId } from "../kernel/appid.ts";
import { signature, type CaptureDay, type ClipLike, type MediaItem, type Scope, type ScreenshotLike } from "../kernel/captures.ts";

export { signature };
export type { CaptureDay, ClipLike, MediaItem, Scope, ScreenshotLike };

/** Is this app covered by the user's settings? */
export function inScope(appid: number, scope: Scope): boolean {
    return isShortcutAppId(appid) ? scope.nonSteamGames : scope.steamGames;
}

export function screenshotItem(appid: number, s: ScreenshotLike): MediaItem {
    return {
        id: `capture_${appid}_${s.hHandle || s.nCreated}`,
        url: s.strUrl,
        caption: s.strCaption || "",
        timestamp: s.nCreated,
        width: s.nWidth,
        height: s.nHeight,
        isClip: false,
        rawScreenshot: s,
    };
}

export function clipItem(appid: number, c: ClipLike): MediaItem {
    return {
        id: `capture_${appid}_clip_${c.clip_id}`,
        url: c.thumbnail_url,
        caption: "Clip",
        timestamp: c.date_clipped || c.date_recorded || 0,
        width: c.thumbnail_width || 1920,
        height: c.thumbnail_height || 1080,
        isClip: true,
        rawClip: c,
    };
}

/**
 * Screenshots and clips grouped by `dayOf(timestamp)`, newest day first and newest capture first within a day.
 * A capture with no time (0) is left out: it has no day to go on.
 */
export function captureDays(
    appid: number,
    screenshots: readonly ScreenshotLike[],
    clips: readonly ClipLike[],
    dayOf: (unixSeconds: number) => number,
): CaptureDay[] {
    const items = [...screenshots.map((s) => screenshotItem(appid, s)), ...clips.map((c) => clipItem(appid, c))]
        .filter((i) => i.timestamp > 0)
        .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    const byDay = new Map<number, MediaItem[]>();
    for (const item of items) {
        const day = dayOf(item.timestamp);
        const list = byDay.get(day);
        if (list) list.push(item);
        else byDay.set(day, [item]);
    }
    return [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, list]) => ({ day, items: list }));
}


/**
 * The apps the sweep re-reads, most recently viewed last. `touch` moves an app to the end and returns the one that
 * fell out (over `max`), whose feed entries the caller removes.
 */
export interface Recent {
    touch(appid: number): number | undefined;
    delete(appid: number): void;
    has(appid: number): boolean;
    list(): number[];
}

export function createRecent(max: number): Recent {
    const order = new Set<number>();
    return {
        touch(appid) {
            order.delete(appid);
            order.add(appid);
            if (order.size <= max) return undefined;
            const oldest = order.values().next().value as number;
            order.delete(oldest);
            return oldest;
        },
        delete: (appid) => void order.delete(appid),
        has: (appid) => order.has(appid),
        list: () => [...order],
    };
}
