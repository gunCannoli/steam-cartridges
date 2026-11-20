import { deps } from "./deps";
import { steamQueryClients } from "../../steam/query-client";
import { captureKind } from "./media-kinds";
import { ensureInViewerCache, inViewerCache, knownScreenshot } from "./viewer-cache";

/**
 * Sensors for the screenshots and clips Steam draws on a game's page (the Post-Game Summary and the media viewer).
 *
 * They change nothing. They only leave log lines, because a Linux reporter saw thumbnails of deleted screenshots and a
 * "problem loading this screenshot" page after a click, and neither shows up in any other log. Lines carry booleans,
 * counts and the kind of file, never a path, a game name or an id.
 *
 * Two sensors, attached to every Steam window we can reach (the library window opens after us, so `attach` runs again
 * on each page view; a document is only ever attached once):
 *   - an image or video of a capture that fails to load (the `error` event does not bubble, so it is caught on capture);
 *   - a click on a capture image, with what the image was doing and where Steam went next.
 */

const MAX_LINES = 20;
const attached = new WeakSet<Document>();
const told = new Set<string>();
let lines = 0;

function say(key: string, message: string): void {
    if (told.has(key) || lines >= MAX_LINES) return;
    told.add(key);
    lines += 1;
    deps.log(message);
}

function sourceOf(el: unknown): string {
    const e = el as { currentSrc?: string; src?: string } | null;
    return (e?.currentSrc || e?.src || "") as string;
}

function hostOk(url: string): boolean {
    return /^https:\/\/steamloopback\.host\//.test(url);
}

/** Steam's own words for "the viewer could not show this screenshot", in the user's language (English if it is not found). */
function viewerErrorText(): string {
    try {
        const text = (globalThis as any).LocalizationManager?.LocalizeString?.("#ScreenshotUploader_FailedToLoadScreenshot");
        if (typeof text === "string" && text && !text.startsWith("#")) return text;
    } catch {
        // English below.
    }
    return "There was a problem loading this screenshot";
}

function viewerErrorShown(doc: Document): boolean {
    try {
        return (doc.body?.innerText ?? "").includes(viewerErrorText());
    } catch {
        return false;
    }
}

/** Watch one document. Safe to call twice. */
function watch(doc: Document): void {
    if (attached.has(doc)) return;
    attached.add(doc);

    doc.addEventListener(
        "error",
        (ev: Event) => {
            const target = ev.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag !== "IMG" && tag !== "VIDEO") return;
            const url = sourceOf(target);
            const kind = captureKind(url);
            if (!kind) return;
            say(`error|${kind}|${hostOk(url)}`, `media load failed: kind=${kind} element=${tag.toLowerCase()} loopback_host=${hostOk(url)}`);
        },
        true,
    );

    // Capture phase: this runs before Steam's own click handler opens the viewer, so a screenshot the viewer cannot find
    // is put in its list in time (the viewer reads the list when it opens).
    doc.addEventListener(
        "click",
        (ev: Event) => {
            const img = (ev.target as HTMLElement | null)?.closest?.("img, video") ?? null;
            const url = sourceOf(img);
            const kind = captureKind(url);
            if (!img || !kind) return;
            const loaded = (img as HTMLImageElement).complete === true && (img as HTMLImageElement).naturalWidth > 0;
            const shot = knownScreenshot(url);
            const clients = steamQueryClients();
            const before = shot ? inViewerCache(shot, clients) : undefined;
            let repaired = false;
            if (shot && before === false) {
                try {
                    repaired = ensureInViewerCache([shot], clients).added > 0;
                } catch {
                    // The log line below says nothing was added.
                }
            }
            say(
                `click|${kind}|${loaded}|${before}|${repaired}`,
                `media click: kind=${kind} image_loaded=${loaded} known_to_summary=${shot !== undefined} ` +
                    `in_viewer_cache=${before === undefined ? "unknown" : before} repaired_before_open=${repaired}`,
            );

            // Steam's own error text appearing within a few seconds is the failure the reporter sees. Heal it once, and say so.
            if (!shot) return;
            for (const wait of [500, 1500, 3000]) {
                setTimeout(() => {
                    if (!viewerErrorShown(doc)) return;
                    let healed = false;
                    try {
                        healed = ensureInViewerCache([shot], steamQueryClients()).added > 0;
                    } catch {
                        // Said in the line below.
                    }
                    say(
                        `viewer-error|${wait}|${healed}`,
                        `media viewer showed its load error ${wait} ms after a click: in_viewer_cache_after=${inViewerCache(shot, steamQueryClients())} ` +
                            `added_now=${healed} image_loaded=${loaded}`,
                    );
                }, wait);
            }
        },
        true,
    );
}

/** Attach to the Steam windows reachable now. Called at install and on each page view. */
export function attachMediaSensors(): void {
    try {
        const windows = (globalThis as any).SteamUIStore?.WindowStore?.SteamUIWindows ?? [];
        for (const w of windows) {
            const doc: Document | undefined = w?.BrowserWindow?.document;
            if (doc) watch(doc);
        }
    } catch {
        // A window that cannot be reached is not worth a line of its own.
    }
}
