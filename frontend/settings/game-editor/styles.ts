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
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
};
