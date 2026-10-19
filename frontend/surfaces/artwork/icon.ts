// Surface `artwork`: the shortcut's library icon (icon plan). Not a SetCustomArtworkForApp slot:
// Steam draws a shortcut's icon from the file its shortcuts.vdf `icon` field names, or from the
// exe when that is empty (32 px, pixelated when scaled up). app/artwork stored our copy of the image
// through the backend (M10); this points the shortcut at it with SteamClient.Apps.SetShortcutIcon,
// which rewrites shortcuts.vdf and swaps the overview's icon_data at once. Runtime imports carry
// `.ts` so Node can run tests/artwork-icon.test.ts.
import { logger } from "../../logger.ts";
import type { IconPlan } from "../../kernel/record";
import { deps } from "./deps.ts";

/** Called on the object: never extract the method. False when Steam has no such call. */
async function setShortcutIcon(appid: number, path: string): Promise<boolean> {
    const apps = (globalThis as any).SteamClient?.Apps;
    if (typeof apps?.SetShortcutIcon !== "function") {
        logger.warn("SteamClient.Apps.SetShortcutIcon is not available.");
        return false;
    }
    await apps.SetShortcutIcon(appid, path);
    return true;
}

/** Point the shortcut at our stored icon (`path`) or put back the one ours replaced (`restore`).
 *  True when ours was set (app/artwork then records it). Kill switch: `artwork`. */
export async function applyIcon(appid: number, plan: IconPlan): Promise<boolean> {
    if (!deps.isEnabled("artwork")) return false;
    if ("restore" in plan) {
        if (await setShortcutIcon(appid, plan.restore)) logger.info(`Restored the library icon for appid ${appid}`);
        return false;
    }
    if (!(await setShortcutIcon(appid, plan.path))) return false;
    logger.info(`Set the library icon for appid ${appid}`);
    return true;
}
