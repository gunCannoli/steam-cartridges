// Surface `properties`, pure part: recognising the shortcut Properties dialog's page list (no Steam, no React, so Node
// runs the unit tests). See index.ts.
import { toShortcutId, type ShortcutId } from "../../kernel/appid.ts";

export const ROUTE_PREFIX = "/app/:appid/properties/";
export const SHORTCUT_ROUTE = `${ROUTE_PREFIX}shortcut`;
export const CARTRIDGE_ROUTE = `${ROUTE_PREFIX}cartridge`;
/** Steam's own list has at most seven entries; a longer array is something else. */
export const MAX_PAGES = 20;

export interface PageEntry {
    title: string;
    route: string;
    link: string;
    content: unknown;
}

/**
 * The shortcut dialog's page list in `props`, or undefined. O(1) per call (guardrail 2: this runs for every element in
 * the client): property reads and comparisons only. Every entry must have a string `route` under
 * `/app/:appid/properties/` and a string `link`, the test non-steam-playtimes applies before it adds its own page.
 */
export function shortcutPages(props: unknown): PageEntry[] | undefined {
    if (!props || typeof props !== "object") return undefined;
    const pages = (props as { pages?: unknown }).pages;
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) return undefined;
    if ((pages[0] as PageEntry | undefined)?.route !== SHORTCUT_ROUTE) return undefined;
    for (const page of pages as PageEntry[]) {
        if (!page || typeof page.route !== "string" || !page.route.startsWith(ROUTE_PREFIX) || typeof page.link !== "string") return undefined;
        if (page.route === CARTRIDGE_ROUTE) return undefined; // already there
    }
    return pages as PageEntry[];
}

/** The appid in a page's link (`/app/<appid>/properties/<name>`), as a shortcut id. */
export function appidOfLink(link: string): ShortcutId | undefined {
    return toShortcutId(Number(link.split("/")[2]));
}
