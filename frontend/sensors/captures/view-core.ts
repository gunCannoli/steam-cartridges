// View sensor, pure part: turns raw Steam signals into one `viewed` / `left` per real navigation, for every library
// app (Steam games and shortcuts alike). Adapted from steam-cartridges' sensors/view/core.ts. Only `.ts` imports, so
// the unit tests load it with node.
import { toUnsigned } from "../../kernel/appid.ts";

export type ViewMode = "desktop" | "gamepad";
export interface ViewPayload {
    /** Unsigned appid (kernel/appid toUnsigned). */
    appid: number;
    mode: ViewMode;
}

/**
 * Big Picture has no "left the page" signal (steam/gamepad-appid.ts): it re-renders the app-details element many
 * times while a page is open. The same appid seen again after this much silence counts as a new view.
 */
export const GAMEPAD_QUIET_MS = 2000;

export interface ViewTrackerOptions {
    viewed: (p: ViewPayload) => void;
    left: (p: ViewPayload) => void;
    now: () => number;
    quietMs?: number;
}

export interface ViewTracker {
    /** Desktop: the main window's route now shows this appid (undefined: not an app page). */
    route(raw: unknown): void;
    /** Big Picture: the app-details element rendered with this appid. */
    sighting(raw: unknown): void;
    /** The window of this mode closed: leave whatever it showed. */
    close(mode: ViewMode): void;
    current(mode: ViewMode): number | undefined;
}

export function createViewTracker(opts: ViewTrackerOptions): ViewTracker {
    const quietMs = opts.quietMs ?? GAMEPAD_QUIET_MS;
    const current: Record<ViewMode, number | undefined> = { desktop: undefined, gamepad: undefined };
    let lastSighting = -Infinity;

    const move = (mode: ViewMode, next: number | undefined): void => {
        const prev = current[mode];
        if (prev === next) return;
        current[mode] = next;
        if (prev !== undefined) opts.left({ appid: prev, mode });
        if (next !== undefined) opts.viewed({ appid: next, mode });
    };

    return {
        route(raw) {
            move("desktop", raw === undefined ? undefined : toUnsigned(raw));
        },
        sighting(raw) {
            const now = opts.now();
            const appid = toUnsigned(raw);
            const reopened = appid !== undefined && appid === current.gamepad && now - lastSighting >= quietMs;
            lastSighting = now;
            if (reopened) opts.viewed({ appid, mode: "gamepad" });
            else move("gamepad", appid);
        },
        close(mode) {
            move(mode, undefined);
        },
        current: (mode) => current[mode],
    };
}
