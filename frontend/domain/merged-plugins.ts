// Domain: features that were separate plugins and now live in steam-cartridges (2026-11-12): captured activity (the
// steam-captured-activity plugin) and playtime (the steam-non-steam-playtimes plugin). Pure policy: when our copy runs,
// and playtime's one-time import (captured activity has none: off until the user turns it on, 2026-11-13). Tests load it with node.

/**
 * Our captured-activity copy runs only when the toggle is on and the old plugin is not loaded: two copies would put every
 * capture in the feed twice. The old plugin then keeps doing the job until the user removes it.
 */
export function capturedActivityActive(toggle: boolean, oldPluginLoaded: boolean): boolean {
    return toggle && !oldPluginLoaded;
}

/** Playtime's setting: "auto" decides by what is installed, "on" / "off" are the user's own choice. */
export type PlaytimeMode = 'auto' | 'on' | 'off';

/**
 * Our playtime runs when the user said "on", or on "auto" while steam-non-steam-playtimes is not loaded: with it loaded,
 * it keeps doing the job alone (2026-11-13, the user: a 0.7.3 user's backend crashed at every start with both installed).
 */
export function playtimeActive(mode: PlaytimeMode, otherLoaded: boolean): boolean {
    return mode === 'on' || (mode === 'auto' && !otherLoaded);
}

/** The one-time import of steam-non-steam-playtimes' sessions: only once ours is active, and only once. */
export function shouldImportOtherPlaytimes(active: boolean, migrated: boolean): boolean {
    return active && !migrated;
}
