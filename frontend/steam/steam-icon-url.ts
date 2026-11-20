// Pure (no imports): the address of a Steam achievement picture. See steamIconUrl.

/** Steam keeps a picture as `<40 hex>.<ext>` under its app's folder. Some apps list pictures their CDN does not serve at all
 *  (app 4636030, 2026-11-19: 404 on every host): the backend then keeps the store's own pictures (provided_rpc). */
export const STEAM_ICON_HOSTS = {
    cdn: 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/',
    community: 'https://community.cloudflare.steamstatic.com/steamcommunity/public/images/apps/',
} as const;
export type SteamIconHost = keyof typeof STEAM_ICON_HOSTS;

const BARE = /^[0-9a-f]{40}\.[a-z]{3,4}$/i;
const FULL = /^https:\/\/(?:cdn|community)\.cloudflare\.steamstatic\.com\/steamcommunity\/public\/images\/apps\/(\d+)\/([0-9a-f]{40}\.[a-z]{3,4})$/i;

/** The Steam app and file a picture belongs to: a bare file name (with the app that owns it) or one of our full addresses. */
export function parseSteamIcon(icon: string | undefined | null, nativeAppId: number | undefined): { app: number; file: string } | undefined {
    if (!icon) return undefined;
    if (BARE.test(icon)) return nativeAppId && nativeAppId > 0 ? { app: nativeAppId, file: icon } : undefined;
    const m = FULL.exec(icon);
    return m ? { app: Number(m[1]), file: m[2]! } : undefined;
}

/** The address of a Steam picture on a host. */
export function steamIconAddress(app: number, file: string, host: SteamIconHost = 'cdn'): string {
    return `${STEAM_ICON_HOSTS[host]}${app}/${file}`;
}

/**
 * Steam stores an achievement's picture as a bare file name and its UI draws it from the app's folder on its CDN. We hand Steam
 * the picture for a shortcut, so a bare name would be a blank box: the full address of the Steam app the picture belongs to (a
 * schema Steam made carries `native_appid`). Anything else (a data: URL, another address) is left alone.
 */
export function steamIconUrl(icon: string | undefined | null, nativeAppId: number | undefined, host: SteamIconHost = 'cdn'): string | undefined {
    if (!icon) return icon ?? undefined;
    const p = parseSteamIcon(icon, nativeAppId);
    return p ? steamIconAddress(p.app, p.file, host) : icon;
}
