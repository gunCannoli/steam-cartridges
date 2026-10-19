// Kernel: the manuals app/manuals opened (features plan F2c, ADR-0048), as page images waiting for the community
// surface's viewer. Kept out of GameRecord like the media bin (kernel/media-bin.ts): the pages live only in memory,
// behind blob URLs, and nothing is written to disk. Bounded to the last MAX_MANUALS manuals; an evicted or replaced
// page URL is given to `release` (ports/image releaseObjectUrl). Listeners are told of every change, so the viewer
// shows each page as soon as it is rendered. Each manual's first page is also kept as a card cover (MAX_COVERS), apart
// from the page sets, so the Community card can show it before the manual is opened.

export interface ManualPage {
    /** An object URL (blob:) of the rendered page, or undefined while it is not rendered yet. */
    url?: string;
    /** The page's size in PDF points: the viewer reserves its space before the image exists. */
    width: number;
    height: number;
}

export interface ManualView {
    status: "loading" | "ready" | "failed";
    pages: ManualPage[];
}

export interface ManualShelf {
    get(appid: number, key: string): ManualView | undefined;
    set(appid: number, key: string, view: ManualView): void;
    /** The manual's first page as a 16:9 card cover (an object URL), when it has been rendered. */
    cover(appid: number, key: string): string | undefined;
    setCover(appid: number, key: string, url: string): void;
    /** Called after every set; returns the unsubscribe function. */
    subscribe(listener: () => void): () => void;
}

export const MAX_MANUALS = 2;
/** Covers are one image each and the card shows them without the manual being opened: more are kept than page sets. */
export const MAX_COVERS = 8;

export function createManualShelf(release: (url: string) => void): ManualShelf {
    const map = new Map<string, ManualView>();
    const covers = new Map<string, string>();
    const listeners = new Set<() => void>();
    const id = (appid: number, key: string) => `${appid}:${key}`;
    const notify = () => {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                /* a listener must never break the shelf */
            }
        }
    };
    const urls = (view: ManualView | undefined) => new Set((view?.pages ?? []).map((p) => p.url).filter((u): u is string => !!u));
    return {
        get: (appid, key) => map.get(id(appid, key)),
        set(appid, key, view) {
            const k = id(appid, key);
            const kept = urls(view);
            urls(map.get(k)).forEach((url) => kept.has(url) || release(url));
            map.delete(k); // re-insert: the map's order is the recency order
            map.set(k, view);
            while (map.size > MAX_MANUALS) {
                const oldest = map.keys().next().value as string;
                urls(map.get(oldest)).forEach(release);
                map.delete(oldest);
            }
            notify();
        },
        cover: (appid, key) => covers.get(id(appid, key)),
        setCover(appid, key, url) {
            const k = id(appid, key);
            const old = covers.get(k);
            if (old && old !== url) release(old);
            covers.delete(k);
            covers.set(k, url);
            while (covers.size > MAX_COVERS) {
                const oldest = covers.keys().next().value as string;
                release(covers.get(oldest)!);
                covers.delete(oldest);
            }
            notify();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
}
