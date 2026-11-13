// Domain: features that were separate plugins and now live in steam-cartridges (2026-11-12): captured activity (the
// steam-captured-activity plugin) and playtime (the steam-non-steam-playtimes plugin). Pure policy: when our copy runs,
// and playtime's one-time migration (captured activity has none: off until the user turns it on, 2026-11-13). Tests load it with node.

/**
 * Our captured-activity copy runs only when the toggle is on and the old plugin is not loaded: two copies would put every
 * capture in the feed twice. The old plugin then keeps doing the job until the user removes it.
 */
export function capturedActivityActive(toggle: boolean, oldPluginLoaded: boolean): boolean {
    return toggle && !oldPluginLoaded;
}

/** Playtime: switched on by the migration when steam-non-steam-playtimes was installed (it has no setting of its own). */
export function migratePlaytime(old: { loaded: boolean; sessionsFound: boolean }): boolean | undefined {
    return old.loaded || old.sessionsFound ? true : undefined;
}
