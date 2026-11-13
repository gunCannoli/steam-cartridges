// Captures sensor (the captured-activity feature, ported from the steam-captured-activity plugin 2026-11-12): the only
// code that detects, for any app (Steam games and shortcuts alike), its page being opened, its process quitting, and Steam
// saying a screenshot or clip of it was saved or deleted; and which Steam windows open and close (Big Picture styling).
// Emits app.viewed / app.quit / capture.changed / window.opened / window.closed on the bus. Never writes to Steam.
// The shortcut-only view and lifecycle sensors stay as they are; this one exists because captures cover Steam games too.
import { Steam } from "steambrew-utils";
import { onAppLaunch, onLocationChange, onPopupCreate, PopupType } from "steambrew-utils/watchers";
import { appidFromGameId, toUnsigned } from "../../kernel/appid";
import type { EventBus } from "../../kernel/events";
import { captureEvents } from "../../steam/captures";
import { watchGamepadAppid } from "../../steam/gamepad-appid";
import { appIdFromPath } from "../../steam/route";
import { createViewTracker } from "./view-core";

let installed = false;

/**
 * Install once, after every subscriber is registered: onPopupCreate replays the windows already open and onLocationChange
 * reports the current route immediately. Everything is emitted on a timer, never synchronously: a Big Picture sighting
 * arrives from inside Steam's render and a capture event from inside Steam's notification dispatch (guardrail 17).
 * Returns how many of Steam's three capture event sources are live (0 to 3; the publisher's sweep covers the rest).
 */
export function installCapturesSensor(bus: EventBus): number {
    if (installed) return 0;
    installed = true;
    const later = (fn: () => void) => void setTimeout(fn, 0);

    const tracker = createViewTracker({
        now: () => Date.now(),
        viewed: (p) => later(() => bus.emit("app.viewed", { appid: p.appid, mode: p.mode })),
        left: () => {
            /* the feed stays: Steam's store is global, and the sweep keeps it true */
        },
    });

    let gamepadWindows = 0;
    watchGamepadAppid((appid) => {
        if (gamepadWindows > 0) tracker.sighting(appid);
    });

    onPopupCreate((popup, type) => {
        const document: unknown = (popup as any)?.window?.document;
        if (type === PopupType.Desktop) {
            const stop = onLocationChange(
                () => Steam.MainWindowBrowserManager?.m_lastLocation,
                ({ pathname }) => tracker.route(appIdFromPath(pathname)),
            );
            later(() => bus.emit("window.opened", { mode: "desktop", document }));
            return () => {
                stop();
                tracker.close("desktop");
                later(() => bus.emit("window.closed", { mode: "desktop", document }));
            };
        }
        if (type === PopupType.Gamepad) {
            gamepadWindows++;
            later(() => bus.emit("window.opened", { mode: "gamepad", document }));
            return () => {
                gamepadWindows--;
                if (gamepadWindows === 0) tracker.close("gamepad");
                later(() => bus.emit("window.closed", { mode: "gamepad", document }));
            };
        }
        return undefined;
    });

    onAppLaunch((app, { onQuit }) => {
        const appid = toUnsigned(app.appid);
        if (!appid) return;
        onQuit(() => later(() => bus.emit("app.quit", { appid })));
    });

    const report = (appid: number | undefined, what: "screenshot-written" | "screenshot-deleted" | "clip-created" | "clip-deleted") => {
        if (appid !== undefined && appid !== 0) later(() => bus.emit("capture.changed", { appid, what }));
    };
    let live = 0;
    if (
        captureEvents.onScreenshot((n) => {
            if (n?.strOperation === "written") report(toUnsigned(n.unAppID), "screenshot-written");
            else if (n?.strOperation === "deleted") report(toUnsigned(n.unAppID), "screenshot-deleted");
        })
    )
        live++;
    if (captureEvents.onClipCreated((b) => report(appidFromGameId(b?.summary?.game_id, b?.summary?.clip_id), "clip-created"))) live++;
    if (captureEvents.onClipDeleted((b) => report(appidFromGameId(b?.game_id, b?.clip_id), "clip-deleted"))) live++;
    return live;
}
