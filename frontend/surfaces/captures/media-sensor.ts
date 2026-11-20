import { deps } from "./deps";
import { captureKind, routeShape } from "./media-kinds";

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

/** Watch one document. Safe to call twice. */
function watch(doc: Document): void {
    if (attached.has(doc)) return;
    attached.add(doc);
    const win = doc.defaultView;

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

    doc.addEventListener(
        "click",
        (ev: Event) => {
            const img = (ev.target as HTMLElement | null)?.closest?.("img, video") ?? null;
            const url = sourceOf(img);
            const kind = captureKind(url);
            if (!img || !kind) return;
            const loaded = (img as HTMLImageElement).complete === true && (img as HTMLImageElement).naturalWidth > 0;
            const before = routeShape(win?.location?.pathname ?? "");
            setTimeout(() => {
                const after = routeShape(win?.location?.pathname ?? "");
                // The first click per kind and outcome is enough to see whether the viewer opens and from what state.
                say(
                    `click|${kind}|${loaded}|${after.startsWith("/media")}`,
                    `media click: kind=${kind} image_loaded=${loaded} route_before=${before} route_after=${after} ` +
                        `viewer_opened=${after.startsWith("/media")}`,
                );
            }, 1500);
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
