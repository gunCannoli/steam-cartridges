import { deps } from "./deps";
import { captureKind } from "./media-kinds";

/**
 * Sensor for the screenshots and clips Steam draws (the Post-Game Summary and the media viewer): an image or video of a
 * capture that fails to load. It changes nothing; it leaves a log line (booleans, counts and the kind of file, never a
 * path, a game name or an id).
 *
 * Attached to the windows reachable at each page view, and to the Media window a Post-Game Summary click opens (the
 * screenshot trail, trail.ts, finds that window and calls `watchDocument`). A click on a summary thumbnail and what the
 * viewer shows next are the trail's lines, not this sensor's.
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

/** Watch one document for capture images that fail to load. Safe to call twice. */
export function watchDocument(doc: Document): void {
    if (attached.has(doc)) return;
    attached.add(doc);

    // The `error` event does not bubble, so it is caught on capture.
    doc.addEventListener(
        "error",
        (ev: Event) => {
            const target = ev.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag !== "IMG" && tag !== "VIDEO") return;
            const url = sourceOf(target);
            const kind = captureKind(url);
            if (!kind) return;
            const where = target?.closest?.(".FocusedScreenshotImageContainer, .FocusedScreenshots")
                ? "viewer"
                : target?.closest?.(".GamePlaySummaryContainer")
                  ? "post-game-summary"
                  : "other";
            say(
                `error|${kind}|${hostOk(url)}|${where}`,
                `media load failed: kind=${kind} element=${tag.toLowerCase()} loopback_host=${hostOk(url)} where=${where}`,
            );
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
            if (doc) watchDocument(doc);
        }
    } catch {
        // A window that cannot be reached is not worth a line of its own.
    }
}
