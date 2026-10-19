// Domain: which community media a shortcut shows (features plan F2). Pure: the settings toggles and a cap per kind.
// Its imports carry `.ts`, so Node can run the unit tests with type stripping.
import type { CommunityMedia, MediaItem } from "../kernel/record";
import { asList } from "../kernel/lists.ts";

/** Settings communityShowTrailers, communityShowArtworks and communityShowManuals. */
export interface MediaToggles {
    trailers: boolean;
    artworks: boolean;
    manuals: boolean;
}

/** At most this many cards of each kind (Steam's section loads one page; more is a wall of art). */
export const MAX_PER_KIND = 12;

/** Is this item complete enough to become a card? */
export function isShowable(item: MediaItem | undefined): item is MediaItem {
    if (!item || typeof item !== "object") return false;
    if (item.kind === "video") return typeof item.youtube === "string" && item.youtube !== "";
    if (item.kind === "manual") return item.source === "screenscraper" && typeof item.key === "string" && item.key !== "";
    if (item.kind !== "screenshot" && item.kind !== "artwork") return false;
    if (item.source === "screenscraper") return typeof item.key === "string" && item.key !== "";
    return typeof item.url === "string" && item.url !== "";
}

/**
 * The items to show: allowed by the toggles, complete, at most MAX_PER_KIND per kind. Order: the manual first (the user
 * wants it as the top-left card, features plan F2c), then trailers, then the screenshots of the store the copy was bought
 * on (an extension's pushed media, e.g. Epic or Xbox: the game's own, ADR-0067), then the images ScreenScraper has for this exact game (chosen by ROM and
 * console, so the most specific), then IGDB's. The ScreenScraper images go before IGDB's so IGDB's larger sets can neither
 * crowd them out of the cap nor leave them at the end of the grid, where Steam's row layout drops a card that fits no row.
 */
export function visibleMedia(media: CommunityMedia | undefined, toggles: MediaToggles): MediaItem[] {
    const counts: Record<string, number> = {};
    const rank = (item: MediaItem) =>
        item.kind === "manual" ? -1
        : item.kind === "video" ? 0
        : item.source !== "igdb" && item.source !== "screenscraper" ? 1 // an extension's pushed media (ADR-0067)
        : item.source === "screenscraper" ? 2
        : 3;
    const wanted = asList<MediaItem>(media?.items)
        .filter(isShowable)
        .filter((item) => (item.kind === "video" ? toggles.trailers : item.kind === "manual" ? toggles.manuals : toggles.artworks))
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
        .map((entry) => entry.item);
    const out: MediaItem[] = [];
    for (const item of wanted) {
        counts[item.kind] = (counts[item.kind] ?? 0) + 1;
        if (counts[item.kind]! > MAX_PER_KIND) continue;
        out.push(item);
    }
    return out;
}
