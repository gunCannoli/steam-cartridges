// Surface `captured-activity` (ported from the steam-captured-activity plugin 2026-11-12): the screenshots and recordings
// Steam captured, as one "{Username} captured" event per day in every game's Activity feed (Steam games and shortcuts),
// with Steam's own Post-Game Summary cards. Files: feed (Steam's activity store), stub (a shortcut's store item),
// headline and cards (jsx), bpm-style (Big Picture thumbnails). Off unless the General toggle is on (index.tsx).
// Reads no record part: app/captured-activity decides what each app shows and calls publish / clear here.
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import type { CaptureDay } from "../../kernel/captures";
import { setDeps } from "./context";
import { clear, feedDiagnostics, needsRepair, publish } from "./feed";
import { cardsJsxDiagnostics, installActivityCardsPatch } from "./cards";
import { headlineJsxDiagnostics, installHeadlinePatch } from "./headline";
import { onWindowClosed, onWindowOpened } from "./bpm-style";

export interface CapturedActivitySurface extends Surface {
    /** Install the jsx patches: only once the feature is on (install() does nothing, so off leaves Steam untouched). */
    start(): void;
    publish(appid: number, days: CaptureDay[]): boolean;
    clearApp(appid: number): void;
    needsRepair(appid: number): boolean;
    windowOpened(p: { mode: "desktop" | "gamepad"; document: unknown }): void;
    windowClosed(p: { mode: "desktop" | "gamepad"; document: unknown }): void;
    diagnostics(): unknown;
}

export function createCapturedActivitySurface(deps: SurfaceDeps): CapturedActivitySurface {
    setDeps(deps);
    let installed = false;
    return {
        id: "captured-activity",
        touches: [
            "appActivityStore.m_mapAppActivity (set wrapper: merges capture events)",
            "workshopStore.m_mapPublishedFiles (capture_<appid>_* records)",
            "StoreItemCache.m_mapApps / React Query StoreItem (shortcut store item)",
            "jsx: EventHeadline (\" captured\"), activity carousel (Post-Game Summary cards)",
            "a <style> in each Big Picture window",
        ],
        reads: [],
        install() {
            /* the runner calls this at start-up; the patches wait for start() */
        },
        start() {
            if (installed) return;
            installed = true;
            installHeadlinePatch();
            installActivityCardsPatch();
        },
        render() {
            /* driven by app/captured-activity, not by record parts */
        },
        clear() {
            /* a shortcut's captures stay while the feature is on: the sweep keeps them true */
        },
        uninstall() {
            /* the jsx patches stay (fail-open behind the kill switch); clearApp removes our events */
        },
        publish: (appid, days) => publish(appid, days),
        clearApp: (appid) => clear(appid),
        needsRepair: (appid) => needsRepair(appid),
        windowOpened: (p) => onWindowOpened({ mode: p.mode, document: p.document as Document | undefined }),
        windowClosed: (p) => onWindowClosed({ document: p.document as Document | undefined }),
        diagnostics: () => ({ feed: feedDiagnostics(), headline: headlineJsxDiagnostics(), cards: cardsJsxDiagnostics() }),
    };
}
