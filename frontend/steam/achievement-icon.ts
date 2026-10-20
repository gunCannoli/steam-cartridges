/**
 * The picture an achievement without an icon of its own shows (ADR-0081, phase 0): the game's own icon, as Steam keeps
 * it for the shortcut (the app overview's `icon_data`, which surfaces/captures/activity.ts already reads), else a
 * plain trophy badge drawn here (our own art, nothing of a game's). Without it Steam got `strImage: ""` and drew an
 * empty picture in the achievements list, the toast and the Activity feed (Dusklight has no icons; a beta report,
 * 2026-10-20). Applied where the record becomes Steam's shape, never stored: real icons simply replace it.
 */
import { toUnsigned } from '../kernel/appid';

const BADGE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="10" fill="#1f2a38"/>' +
    '<g fill="#c6d4df"><path d="M18 12h28v12c0 8-6 14-14 14s-14-6-14-14z"/>' +
    '<rect x="29" y="37" width="6" height="9"/><rect x="21" y="46" width="22" height="6" rx="2"/></g>' +
    '<g fill="none" stroke="#c6d4df" stroke-width="4"><path d="M18 16h-5v5c0 5 3 9 7 9"/><path d="M46 16h5v5c0 5-3 9-7 9"/></g>' +
    '</svg>';

export const TROPHY_BADGE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(BADGE_SVG);

/** Shortcuts whose icon data was asked for once already (Steam loads a shortcut's icon lazily). */
const requested = new Set<number>();

/** The game's own icon as a data: URL, or "" (none, or not loaded yet: then Steam is asked to load it, once). */
export function gameIconUrl(appid: number): string {
    const id = toUnsigned(appid) ?? appid;
    const overview = (window as any).appStore?.GetAppOverviewByAppID?.(id);
    const data = overview?.icon_data;
    if (typeof data === 'string' && data) {
        return data.startsWith('data:') ? data : `data:image/${overview.icon_data_format || 'png'};base64,${data}`;
    }
    if (!requested.has(id)) {
        requested.add(id);
        try {
            (window as any).SteamClient?.Apps?.RequestIconDataForApp?.(id);
        } catch {
            // no such API on this Steam build: the badge is used
        }
    }
    return '';
}

/** The icon to give Steam for an achievement of `appid`: its own, else the game's, else the trophy badge. */
export function achievementIcon(icon: string | undefined | null, appid: number): string {
    return icon || gameIconUrl(appid) || TROPHY_BADGE;
}
