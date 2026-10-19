// View sensor, pure part (migration plan M2, ADR-0039). Turns raw Steam signals into
// shortcut.viewed / shortcut.left, one per real navigation. Only `import type` here, so
// tests/sensors.test.ts can load it with node.
import type { ShortcutId } from "../../kernel/appid";

export type ViewMode = "desktop" | "gamepad";
export interface ViewPayload {
    appid: ShortcutId;
    mode: ViewMode;
}

/**
 * Big Picture has no "left the page" signal (steam/gamepad-appid.ts): it re-renders the
 * app-details element many times while a page is open. The same appid seen again after
 * this much silence counts as a new view (the page was opened again).
 */
export const GAMEPAD_QUIET_MS = 2000;

export interface ViewTrackerOptions {
    /** kernel/appid toShortcutId: undefined for native apps and junk. */
    toShortcutId: (raw: unknown) => ShortcutId | undefined;
    viewed: (p: ViewPayload) => void;
    left: (p: ViewPayload) => void;
    now: () => number;
    quietMs?: number;
}

export interface ViewTracker {
    /** Desktop: the main window's route now shows this appid (undefined: not an app page). */
    route(raw: number | undefined): void;
    /** Big Picture: the app-details element rendered with this appid. */
    sighting(raw: number): void;
    /** The window of this mode closed: leave whatever it showed. */
    close(mode: ViewMode): void;
    current(mode: ViewMode): ShortcutId | undefined;
}

export function createViewTracker(opts: ViewTrackerOptions): ViewTracker {
    const quietMs = opts.quietMs ?? GAMEPAD_QUIET_MS;
    const current: Record<ViewMode, ShortcutId | undefined> = { desktop: undefined, gamepad: undefined };
    let lastSighting = -Infinity;

    /** Move `mode` to `next`; emits left for the old shortcut and viewed for the new one. */
    const move = (mode: ViewMode, next: ShortcutId | undefined): void => {
        const prev = current[mode];
        if (prev === next) return;
        current[mode] = next;
        if (prev !== undefined) opts.left({ appid: prev, mode });
        if (next !== undefined) opts.viewed({ appid: next, mode });
    };

    return {
        route(raw) {
            move("desktop", raw === undefined ? undefined : opts.toShortcutId(raw));
        },
        sighting(raw) {
            const now = opts.now();
            const id = opts.toShortcutId(raw);
            const reopened = id !== undefined && id === current.gamepad && now - lastSighting >= quietMs;
            lastSighting = now;
            if (reopened) opts.viewed({ appid: id, mode: "gamepad" });
            else move("gamepad", id);
        },
        close(mode) {
            move(mode, undefined);
        },
        current: (mode) => current[mode],
    };
}
