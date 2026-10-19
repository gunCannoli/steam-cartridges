// Kernel: the ScreenScraper images app/media fetched for a shortcut (features plan F2b), as object URLs, waiting for
// the community surface to hand them to Steam. Kept out of GameRecord like the image bin (kernel/image-bin.ts): the
// bytes live in memory, behind a blob URL (the backend's disk copy, ADR-0051, is the backend's own). Bounded to the last MAX_MEDIA_APPIDS
// shortcuts; an evicted or replaced URL is given to `release` (ports/image releaseObjectUrl), so memory stays bounded.

export interface MediaImage {
    /** An object URL (blob:) of the image bytes. */
    url: string;
    width?: number;
    height?: number;
}

export interface MediaBin {
    put(appid: number, key: string, image: MediaImage): void;
    /** The image for this shortcut and key, or undefined (never fetched, failed, or evicted). */
    get(appid: number, key: string): MediaImage | undefined;
}

export const MAX_MEDIA_APPIDS = 64;

export function createMediaBin(release: (url: string) => void): MediaBin {
    const map = new Map<number, Map<string, MediaImage>>();
    const drop = (entry: Map<string, MediaImage>) => entry.forEach((image) => release(image.url));
    return {
        put(appid, key, image) {
            const entry = map.get(appid) ?? new Map<string, MediaImage>();
            const previous = entry.get(key);
            if (previous && previous.url !== image.url) release(previous.url);
            entry.set(key, image);
            map.delete(appid); // re-insert: the map's order is the recency order
            map.set(appid, entry);
            while (map.size > MAX_MEDIA_APPIDS) {
                const oldest = map.keys().next().value as number;
                drop(map.get(oldest)!);
                map.delete(oldest);
            }
        },
        get: (appid, key) => map.get(appid)?.get(key),
    };
}
