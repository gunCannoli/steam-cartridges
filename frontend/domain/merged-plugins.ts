// Domain: features that were separate plugins and now live in steam-cartridges (2026-11-12): captured activity (the
// steam-captured-activity plugin) and playtime (the steam-non-steam-playtimes plugin). Pure policy: when our copy runs,
// and playtime's one-time import (captured activity has none: off until the user turns it on, 2026-11-13). Tests load it with node.

import { toUnsigned } from '../kernel/appid.ts';

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

/**
 * ADR-0109: shortcuts another plugin manages. A plugin listed here exports a function on its PLUGIN_LIST slot that says
 * whether a shortcut is its own; steam-cartridges then leaves that shortcut alone (no fetch, no paint, not in Library
 * Setup). The Epic Games plugin (steam-epic-games, id "epic-games") exports `IsEpicApp(appid)` for its own Steam patches.
 */
export const PLUGIN_OWNERS: readonly { pluginId: string; exportName: string; label: string }[] = [
    { pluginId: 'epic-games', exportName: 'IsEpicApp', label: 'the Epic Games plugin' },
];

/**
 * The owner of a shortcut among PLUGIN_OWNERS, or undefined. Pure over `pluginList` (window.PLUGIN_LIST): a missing slot,
 * a missing export, an answer that is not `true`, or a throw all mean "not owned", so a changed or broken plugin never
 * hides a game from us.
 */
export function ownerOf(appid: number, pluginList: unknown, owners = PLUGIN_OWNERS): { pluginId: string; label: string } | undefined {
    const id = toUnsigned(appid);
    if (id === undefined || !pluginList || typeof pluginList !== 'object') return undefined;
    for (const o of owners) {
        try {
            const slot = (pluginList as Record<string, unknown>)[o.pluginId];
            const fn = slot && typeof slot === 'object' ? (slot as Record<string, unknown>)[o.exportName] : undefined;
            if (typeof fn === 'function' && (fn as (a: number) => unknown).call(slot, id) === true) {
                return { pluginId: o.pluginId, label: o.label };
            }
        } catch {
            // a throwing owner check is "not owned" (ADR-0014)
        }
    }
    return undefined;
}
