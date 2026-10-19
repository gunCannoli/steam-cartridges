// Kernel: the image bytes app/artwork fetched for a shortcut, waiting for the artwork surface to write
// them (M10 item 7, the artwork fetch plan). Kept out of GameRecord on purpose: one mapped game's four
// slots are ~585 KB, and the record store keeps every record for the session (~170 MB for 220 shortcuts).
// Bounded to the last MAX_APPIDS shortcuts; reads do not remove, because a render can run twice for one plan.

export type ImageKey = "portrait" | "hero" | "logo" | "wide";

export interface BinImage {
    base64: string;
    ext: string;
}

export type BinImages = Partial<Record<ImageKey, BinImage>>;

export interface ImageBin {
    /** Forget this shortcut's images (a new plan starts from nothing). */
    discard(appid: number): void;
    put(appid: number, key: ImageKey, image: BinImage): void;
    /** What was put for this shortcut, `{}` when nothing (or evicted). Does not remove it. */
    get(appid: number): BinImages;
}

export const MAX_APPIDS = 8;

/** Steam's custom artwork slot numbers and the bin key each one is fetched into. */
export const SLOT_KEYS: Readonly<Record<number, ImageKey>> = { 0: "portrait", 1: "hero", 2: "logo", 3: "wide" };

export function createImageBin(): ImageBin {
    const map = new Map<number, BinImages>();
    return {
        discard: (appid) => void map.delete(appid),
        put(appid, key, image) {
            const entry = map.get(appid) ?? {};
            entry[key] = image;
            map.delete(appid); // re-insert: the map's order is the recency order
            map.set(appid, entry);
            while (map.size > MAX_APPIDS) map.delete(map.keys().next().value as number);
        },
        get: (appid) => map.get(appid) ?? {},
    };
}
