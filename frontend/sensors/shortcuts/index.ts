// Sensor `shortcuts` (M10, ADR-0044): what Steam knows about the user's shortcuts, read on demand.
// The only code that reads a shortcut's title or the shortcut list (was: two copies in index.tsx and
// steam/shortcut.ts). Read-only, zero network.
import { logger } from "../../logger";
import { isShortcutAppId } from "../../kernel/appid";

/** A shortcut's display name: its overview, else its shortcuts.vdf entry; undefined when Steam has neither yet. */
export function shortcutTitle(appid: number): string | undefined {
    try {
        const overview = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
        if (overview?.display_name) return overview.display_name;

        const shortcut = (window as any).SteamClient?.Apps?.GetShortcutData?.(appid);
        if (shortcut?.strAppName) return shortcut.strAppName;
    } catch (err) {
        logger.warn(`Could not read shortcut title for ${appid}:`, err);
    }
    return undefined;
}

/** Every shortcut in the library, with its display name. */
export function listShortcuts(): { appid: number; name: string }[] {
    const all: any[] = (window as any).appStore?.allApps ?? [];
    return all
        .filter((a) => isShortcutAppId(a?.appid))
        .map((a) => ({ appid: a.appid as number, name: String(a.display_name ?? a.appid) }));
}

/** Shortcut launch data (exe, launch options) from SteamClient. */
export function shortcutData(appid: number): { strAppName?: string; szExe?: string; szArguments?: string } | undefined {
    try {
        return (window as any).SteamClient?.Apps?.GetShortcutData?.(appid);
    } catch (err) {
        logger.warn(`Could not read shortcut data for ${appid}:`, err);
    }
    return undefined;
}
