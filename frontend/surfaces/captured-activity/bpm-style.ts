// Surface `bpm-style`: Big Picture activity thumbnail styling. Big Picture renders through a React portal from
// SharedJSContext into the gamepad window (ADR-0029); Steam's own GamePlaySummaryContainer draws the activity
// thumbnails there, and this <style> in that window's document sizes them 16:9. Desktop windows need nothing. Driven
// by the view sensor's window events; watches no popups itself. Moved from steam-cartridges' captures/bpm-style.ts.
import { safety } from "./context";

const STYLE_ID = "captured-activity-bpm-thumbs";

const STYLE = `
          [class*="CarouselThumbs"] {
            display: flex !important;
            flex-direction: row !important;
            overflow-x: auto !important;
            overflow-y: hidden !important;
            gap: 16px !important;
            width: 100% !important;
            max-width: 100% !important;
            flex: 1 1 auto !important;
          }
          [class*="CarouselThumb"]:not([class*="CarouselThumbs"]) {
            width: 320px !important;
            height: 180px !important;
            max-width: 320px !important;
            max-height: 180px !important;
            flex: 0 0 320px !important;
            border-radius: 4px !important;
            overflow: hidden !important;
          }
          [class*="CarouselThumb"]:not([class*="CarouselThumbs"]) [class*="ImageWrapper"] {
            width: 100% !important;
            height: 100% !important;
          }
          [class*="CarouselThumb"]:not([class*="CarouselThumbs"]) img {
            width: 100% !important;
            height: 100% !important;
            object-fit: cover !important;
            display: block !important;
          }
        `;

const styles = new Map<Document, HTMLStyleElement>();

export function onWindowOpened({ mode, document }: { mode: "desktop" | "gamepad"; document: Document | undefined }): void {
    if (mode !== "gamepad" || !document || styles.has(document) || !safety.isEnabled("bpm-style")) return;
    try {
        const el = document.createElement("style");
        el.id = STYLE_ID;
        el.textContent = STYLE;
        document.head?.appendChild(el);
        styles.set(document, el);
    } catch (err) {
        safety.reportError("bpm-style", err);
    }
}

export function onWindowClosed({ document }: { document: Document | undefined }): void {
    if (!document) return;
    styles.get(document)?.remove();
    styles.delete(document);
}
