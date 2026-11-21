// Pure helpers of the screenshot trail (trail.ts): no imports, so a test can load them alone.
//
// Steam's class names keep a readable part next to the hashed one ("_1Rcrr7lch16ywlLssEXZEJ FocusedScreenshotError"),
// so a `.Name` selector finds them across builds. Names read from Steam 1794536281 (modules 71729 and 68854).

/** The Post-Game Summary's container on a game's page. */
export const SUMMARY_SELECTOR = ".GamePlaySummaryContainer";

/** What Steam's screenshot viewer (module 33472) is drawing in one document. */
export type ViewerState = "shown" | "error" | "loading" | "image-broken" | "image-pending" | "none";

interface DocLike {
    querySelector(selector: string): any;
    querySelectorAll?(selector: string): ArrayLike<any>;
}

/**
 * The viewer's state: its error panel (#ScreenshotUploader_FailedToLoadScreenshot), its skeleton while the query loads,
 * or its image (loaded, broken, or still coming). "none" when no viewer is in this document.
 */
export function viewerState(doc: DocLike | null | undefined): ViewerState {
    try {
        if (!doc) return "none";
        if (doc.querySelector(".FocusedScreenshotError")) return "error";
        if (doc.querySelector(".FocusedScreenshotSkeleton")) return "loading";
        const img = doc.querySelector("img.FocusedScreenshot");
        if (img) {
            if (img.complete === true && img.naturalWidth > 0) return "shown";
            if (img.complete === true) return "image-broken";
            return "image-pending";
        }
        return "none";
    } catch {
        return "none";
    }
}

/** A state the viewer stays in until something changes (the trail stops watching there). */
export function viewerSettled(state: ViewerState): boolean {
    return state === "shown" || state === "error" || state === "image-broken";
}

/** The file name at the end of a capture URL, without a query string ("" when none). */
export function fileName(url: unknown): string {
    if (typeof url !== "string" || !url) return "";
    const bare = (url.split("?")[0] ?? "").split("#")[0] ?? "";
    return bare.slice(bare.lastIndexOf("/") + 1);
}

/** Is an image of this file drawn inside the Post-Game Summary of this document? */
export function drawnInSummary(doc: DocLike | null | undefined, url: unknown): boolean {
    const name = fileName(url);
    if (!doc || !name) return false;
    try {
        const box = doc.querySelector(SUMMARY_SELECTOR);
        const imgs = box?.querySelectorAll?.("img") ?? [];
        for (let i = 0; i < imgs.length; i++) {
            const src = imgs[i]?.currentSrc || imgs[i]?.src || "";
            if (fileName(src) === name) return true;
        }
        // Steam draws some thumbnails as a CSS background (its notification card does).
        const styled = box?.querySelectorAll?.("[style*='background-image']") ?? [];
        for (let i = 0; i < styled.length; i++) {
            if (String(styled[i]?.getAttribute?.("style") ?? "").includes(name)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Why the viewer shows its error, from what Steam's code checks (module 33472: query error, image error, or no item
 * found by its lookup in `["screenshots","all"]`):
 *   - image: the item was found but the <img> failed to load;
 *   - not-in-steam-list: Steam's own list (what the viewer builds its cache from) lacks the screenshot, a Steam-side gap;
 *   - not-in-viewer-cache: Steam lists it but the cache the viewer read lacks it;
 *   - query: everything is there, so the query itself failed or the route named another id.
 */
export function viewerErrorCause(p: { imageBroken: boolean; inViewerCache: boolean | undefined; steamListed: boolean | undefined }): string {
    if (p.imageBroken) return "image";
    if (p.steamListed === false) return "not-in-steam-list";
    if (p.inViewerCache === false || p.inViewerCache === undefined) return "not-in-viewer-cache";
    return "query";
}

/** `true`/`false`, or `unknown` for an answer nobody could give. */
export function yesNo(v: boolean | undefined): string {
    return v === undefined ? "unknown" : String(v);
}
