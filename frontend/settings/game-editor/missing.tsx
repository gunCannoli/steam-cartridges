// Game Data editor: the light red highlight of a missing piece (ADR-0076), laid over its rows (components.tsx Overlay).
import { Overlay } from "../components";
import { ISSUE_TINT, ISSUE_TINT_BORDER } from "./styles";

export function Missing({ on, children }: { on: boolean; children: React.ReactNode }) {
    return (
        <Overlay on={on} color={ISSUE_TINT} edge={ISSUE_TINT_BORDER}>
            {children}
        </Overlay>
    );
}
