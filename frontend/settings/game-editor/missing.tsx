// Game Data editor: highlight of a missing piece or successful update, laid over its rows (components.tsx Overlay).
import { Overlay } from "../components";
import { ISSUE_TINT, ISSUE_TINT_BORDER, SUCCESS_TINT, SUCCESS_TINT_BORDER } from "./styles";

export function Missing({
    on,
    variant = "error",
    children,
}: {
    on: boolean;
    variant?: "error" | "success";
    children: React.ReactNode;
}) {
    const color = variant === "success" ? SUCCESS_TINT : ISSUE_TINT;
    const edge = variant === "success" ? SUCCESS_TINT_BORDER : ISSUE_TINT_BORDER;
    return (
        <Overlay on={on} color={color} edge={edge}>
            {children}
        </Overlay>
    );
}
