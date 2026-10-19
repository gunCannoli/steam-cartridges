// View sensor (migration plan M2, ADR-0039): the only code that detects which shortcut
// page the user is looking at. Desktop: the main window's route. Big Picture: the
// app-details element seen through the shared jsx runtime (ADR-0027), counted only while
// a Big Picture window is open. Emits shortcut.viewed / shortcut.left on the bus.
import { Steam } from "steambrew-utils";
import { onLocationChange, onPopupCreate, PopupType } from "steambrew-utils/watchers";
import { logger } from "../../logger";
import { toShortcutId } from "../../kernel/appid";
import type { EventBus } from "../../kernel/events";
import { watchGamepadAppid } from "../../steam/gamepad-appid";
import { appIdFromPath } from "../../steam/route";
import { createViewTracker } from "./core";

let installed = false;

/**
 * Install once, after every subscriber is registered: onPopupCreate replays the windows
 * already open and onLocationChange reports the current route immediately.
 */
export function installViewSensor(bus: EventBus): void {
    if (installed) return;
    installed = true;

    // Emit on a timer, never synchronously: a Big Picture sighting arrives from inside a jsx
    // call, i.e. inside Steam's render, and handlers write Steam stores (guardrail 17).
    // Timers keep the order of the signals.
    const tracker = createViewTracker({
        toShortcutId,
        now: () => Date.now(),
        viewed: (p) =>
            setTimeout(() => {
                logger.info(`Viewed shortcut ${p.appid} (${p.mode}).`);
                bus.emit("shortcut.viewed", p);
            }, 0),
        left: (p) =>
            setTimeout(() => {
                logger.info(`Left shortcut ${p.appid} (${p.mode}).`);
                bus.emit("shortcut.left", p);
            }, 0),
    });

    let gamepadWindows = 0;
    watchGamepadAppid((appid) => {
        if (gamepadWindows > 0) tracker.sighting(appid);
    });

    onPopupCreate((_popup, type) => {
        if (type === PopupType.Desktop) {
            const stop = onLocationChange(
                () => Steam.MainWindowBrowserManager?.m_lastLocation,
                ({ pathname }) => tracker.route(appIdFromPath(pathname)),
            );
            return () => {
                stop();
                tracker.close("desktop");
            };
        }
        if (type === PopupType.Gamepad) {
            gamepadWindows++;
            return () => {
                gamepadWindows--;
                if (gamepadWindows === 0) tracker.close("gamepad");
            };
        }
        return undefined;
    });
}
