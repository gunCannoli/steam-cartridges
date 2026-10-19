// The sections surface's pure rule for Steam's Community Content section (features plan F2). Kept apart from index.ts,
// which needs Steam's stores, so Node can run its unit test.

/**
 * Should the shortcut's page have Steam's Community Content section? Yes when the media has cards, and also while the media
 * is still being fetched (no part yet, or pending): Steam then shows its own placeholder rows with their loading animation
 * and the cards take their place, instead of the section appearing only when the feed is ready. A part that settled without
 * cards (an error, "unsupported", nothing to show) drops the section again.
 */
export function wantsCommunitySection(media: { status?: string; data?: { items?: unknown } } | undefined): boolean {
    if (!media || media.status === "pending") return true;
    return media.status === "ok" && Array.isArray(media.data?.items) && media.data.items.length > 0;
}
