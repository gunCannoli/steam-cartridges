// Opens a dialog in its own Steam popup window, sized by us (ADR-0076): Steam's own `showModal`, the one Steam's dialogs
// and enhanced-notifications' Theme Creator use. Millennium's `showModal` passes no size, and an in-page overlay is
// confined to the settings window, so a big editor needs this. Ported from enhanced-notifications/frontend/steam/modal.ts.
//
// Every dialog is wrapped in Steam's `ConfigContextRoot`: Steam's components assert ("Trying to use ConfigContext without
// a provider!") in a plugin dialog tree without one (verified live 2026-10-14 by enhanced-notifications). Resolved on the
// first call (a click, never a render path), once. Falls back to Millennium's `showModal`, and to no wrapper.
import { cloneElement, createElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { showModal as millenniumShowModal, type ShowModalProps } from "@steambrew/client";
import { logger } from "../logger";
import { steamRequire } from "./modules";

type SteamShowModal = (modal: ReactElement, parent: EventTarget, props: ShowModalProps) => unknown;
type ConfigRoot = ComponentType<{ IN_DESKTOPUI?: boolean; IN_GAMEPADUI?: boolean; children?: ReactNode }>;

let steamShowModal: SteamShowModal | null | undefined;
let configRoot: ConfigRoot | null | undefined;

/** The exports of Steam's modules whose source passes `sourceFilter` and that pass `predicate`. */
function findExports(sourceFilter: (src: string) => boolean, predicate: (value: unknown) => boolean): unknown[] {
    const req = steamRequire();
    if (!req) return [];
    const found: unknown[] = [];
    for (const id of Object.keys(req.m)) {
        let src: string;
        try {
            src = String(req.m[id]);
        } catch {
            continue;
        }
        if (!sourceFilter(src)) continue;
        let mod: unknown;
        try {
            mod = req(id);
        } catch {
            continue;
        }
        if (!mod || typeof mod !== "object") continue;
        for (const value of Object.values(mod as Record<string, unknown>)) {
            try {
                if (predicate(value)) found.push(value);
            } catch {
                /* a throwing getter is just not a match */
            }
        }
    }
    return found;
}

function resolveShowModal(): SteamShowModal | null {
    if (steamShowModal !== undefined) return steamShowModal;
    const hits = findExports(
        (src) => src.includes("RequestModalMeasure") && src.includes("bNeverPopOut"),
        (v) => typeof v === "function" && v.toString().includes("bNeverPopOut") && v.toString().includes("popupWidth"),
    );
    steamShowModal = (hits[0] as SteamShowModal | undefined) ?? null;
    if (!steamShowModal) logger.warn("Steam's showModal not found; using Millennium's (the popup opens at the default size).");
    return steamShowModal;
}

function resolveConfigRoot(): ConfigRoot | null {
    if (configRoot !== undefined) return configRoot;
    const hits = findExports(
        (src) => src.includes("ConfigContext without a provider"),
        (v) => typeof v === "function" && /IN_DESKTOPUI/.test(v.toString()) && /\.Provider/.test(v.toString()),
    );
    configRoot = hits.length === 1 ? (hits[0] as ConfigRoot) : null;
    if (!configRoot) logger.warn(`Steam's ConfigContextRoot resolved to ${hits.length} candidates; dialogs open without it.`);
    return configRoot;
}

/** The dialog inside Steam's config context (desktop: Millennium's settings live there), passing on `closeModal`. */
function withConfig(modal: ReactElement, root: ConfigRoot): ReactElement {
    const Wrapped = ({ closeModal }: { closeModal?: () => void }) =>
        createElement(root, { IN_DESKTOPUI: true, IN_GAMEPADUI: false }, closeModal ? cloneElement(modal, { closeModal } as object) : modal);
    return createElement(Wrapped, { ...(modal.props as object) });
}

/** Opens `modal` in its own Steam popup window of `width` x `height` (desktop), titled `title`, over `parent` (the window
 *  the user clicked in; SharedJSContext's own window is hidden); `onClose` after it closes. */
export function showDialog(modal: ReactElement, opts: { title: string; width: number; height: number; onClose?: () => void; parent?: Window }): void {
    const props: ShowModalProps = { strTitle: opts.title, popupWidth: opts.width, popupHeight: opts.height, bForcePopOut: true, fnOnClose: opts.onClose };
    const steam = resolveShowModal();
    const root = resolveConfigRoot();
    const element = root ? withConfig(modal, root) : modal;
    const parent = opts.parent ?? window;
    // A hidden parent (SharedJSContext, a window minimized to the tray) gets the dialog rendered inside it, where nobody
    // can see or close it (verified live 2026-10-19: copies piled up in the hidden desktop window). Never open one there.
    if (parent.document?.visibilityState === "hidden") {
        logger.warn(`Not opening "${opts.title}": the window it was asked from is hidden.`);
        return;
    }
    if (steam) void steam(element, parent, props);
    else millenniumShowModal(element, parent, props);
}

/** A popup as big as the screen allows (the work area less a small margin), or `scale` of it, never smaller than
 *  1000 x 680. `from` is a visible window: SharedJSContext's own reports a 1 x 1 screen (verified live 2026-10-19). */
export function screenSize(from: Window = window, scale?: number): { width: number; height: number } {
    const scr = from.screen?.availWidth > 100 ? from.screen : undefined;
    const w = scr?.availWidth || 1600;
    const h = scr?.availHeight || 900;
    // A small popup (the Add source windows, scale under 0.5) may be smaller than the big editors' 1000 x 680.
    const [minW, minH] = scale !== undefined && scale < 0.5 ? [700, 480] : [1000, 680];
    return { width: Math.max(minW, Math.round(w * (scale ?? 0.96))), height: Math.max(minH, Math.round(h * (scale ?? 0.94))) };
}
