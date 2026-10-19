/**
 * Pure helpers for the Steam Store bucket. Only `import type` allowed so the
 * node test runner can load this file.
 */
import type { ArtworkUrls } from '../kernel/record';

/**
 * Unhashed CDN paths; they fetch fine for existing apps (P0 T2). Newer apps
 * need hashed URLs from StoreItemCache `GetAssets()`, which the view prefers.
 * No icon: its URL always needs StoreItemCache's hash (icon plan).
 */
export function cdnArtworkUrls(steamAppid: number): Required<Omit<ArtworkUrls, 'icon' | 'iconSmall'>> {
    const base = `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppid}`;
    return {
        portrait: `${base}/library_600x900.jpg`,
        hero: `${base}/library_hero.jpg`,
        logo: `${base}/logo.png`,
        wide: `${base}/header.jpg`,
    };
}
