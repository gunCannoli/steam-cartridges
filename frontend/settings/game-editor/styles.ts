// Game Data editor: the few inline styles its parts share (features plan F1).
import type { CSSProperties } from "react";

/** The one native control Steam has no component for (the description): dressed like Steam's text field. */
export const TEXTAREA_STYLE: CSSProperties = {
    background: "rgba(0, 0, 0, 0.4)",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    color: "#fff",
    borderRadius: "3px",
    padding: "6px 8px",
    fontSize: "13px",
    fontFamily: "inherit",
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
};

/** A missing piece of a game with issues (ADR-0076): a light red tint, and a red edge on the list row. */
export const ISSUE_TINT = "rgba(255, 70, 70, 0.2)";
export const ISSUE_TINT_BORDER = "rgba(230, 70, 70, 0.85)";

/** A card that holds a missing piece: a red edge (the tint itself is an Overlay, see `Missing`). */
export function tint(missing: boolean): CSSProperties {
    return missing ? { borderColor: ISSUE_TINT_BORDER } : {};
}

/** The editor's action runner (modal.tsx): `progress` shows (with Steam's spinner) in the card `from` while `work` runs,
 *  then `done` or the error. */
export type RunAction = (work: () => Promise<{ error?: string } | void>, done: string, progress?: string, from?: string) => void;
