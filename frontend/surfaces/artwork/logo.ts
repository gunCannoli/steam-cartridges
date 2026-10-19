// Surface `artwork` (migration plan M3.9): the logo position that makes a custom logo
// visible. Moved from features/steam-store/logo.ts.
import { logger } from "../../logger";
import { deps } from "./deps";

/**
 * A shortcut's custom logo stays hidden until it has a logo position (parity
 * plan § 1, traced live 2026-09-24): Steam's app header (`TopCapsule`) draws
 * the logo only when `logoPosition !== null`, and for an app without library
 * assets `GetLogoImagesForAppId` reports `null`. Steam's own "Adjust logo
 * position" stores one through `appDetailsStore.SaveCustomLogoPosition`
 * (`<grid>/<appid>.json`); we call the same method with Steam's own default
 * (TopCapsule's fallback `{ BottomLeft, 50, 50 }`).
 */
const DEFAULT_LOGO_POSITION = { pinnedPosition: "BottomLeft", nWidthPct: 50, nHeightPct: 50 };

function handles(appid: number): { store: any; overview: any } | null {
    const store = (window as any).appDetailsStore;
    const overview = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
    return store && overview ? { store, overview } : null;
}

/** Give our logo a position unless one exists (a position the user set is kept). */
export async function ensureLogoPosition(appid: number): Promise<void> {
    if (!deps.isEnabled("artwork")) return;
    try {
        const h = handles(appid);
        if (!h || typeof h.store.SaveCustomLogoPosition !== "function") return;
        await h.store.RequestCustomImageInfo?.(h.overview); // loads <grid>/<appid>.json if present
        if (h.store.GetAppData?.(appid)?.customImageInfo?.logoPosition) return;
        await h.store.SaveCustomLogoPosition(h.overview, DEFAULT_LOGO_POSITION);
        logger.info(`Steam Store: saved a default logo position for ${appid}.`);
    } catch (err) {
        logger.warn(`Could not save a logo position for ${appid}:`, err);
    }
}

/** Remove the logo position together with the logo slot we wrote. */
export async function clearLogoPosition(appid: number): Promise<void> {
    if (!deps.isEnabled("artwork")) return;
    try {
        const h = handles(appid);
        await h?.store.ClearCustomLogoPosition?.(h.overview);
    } catch (err) {
        logger.warn(`Could not clear the logo position for ${appid}:`, err);
    }
}
