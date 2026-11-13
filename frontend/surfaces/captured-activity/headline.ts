// Surface `headline`: the feed's headline for this plugin's capture events reads "{Username} captured" (Steam's own
// action phrasing, like " achieved") instead of the community upload phrasing (" shared 2 screenshots"). Only events
// that carry this plugin's cards (`m_mediaItems`) change; Steam's own screenshot events keep Steam's words. Moved
// from steam-cartridges' surfaces/captures/headline.ts.
import { jsxRuntime } from "../../steam/modules";
import { keepJsxPatched, type JsxHookDiagnostics } from "../../steam/jsx-hook";
import { logger } from "../../logger";
import { safety } from "./context";

interface EventHeadlineProps {
    steamIDActor?: unknown;
    event?: { eEventType?: number; m_mediaItems?: unknown };
    children?: unknown;
}

/** O(1): runs for every element Steam renders (guardrail 2). */
function intercept(props: unknown): void {
    const p = props as EventHeadlineProps | undefined;
    if (!p?.event || !p.steamIDActor || typeof p.children !== "string") return;
    if (p.event.eEventType !== 13 || !Array.isArray(p.event.m_mediaItems)) return;
    Object.assign(p, { children: " captured" });
}

let hook: ReturnType<typeof keepJsxPatched> | undefined;

export function installHeadlinePatch(): void {
    if (hook) return;
    const runtime = jsxRuntime();
    if (!runtime) {
        logger.warn("Could not find react/jsx-runtime; the \"captured\" headline is skipped.");
        return;
    }
    hook = keepJsxPatched(runtime as unknown as Record<"jsx" | "jsxs", (type: unknown, props: unknown, key?: unknown) => unknown>, {
        label: "steam-captured-activity.headline",
        observe: (_type, props) => {
            if (!safety.isEnabled("headline")) return;
            try {
                intercept(props);
            } catch (err) {
                safety.reportError("headline", err);
            }
        },
    });
    logger.info('Installed Activity Feed headline patch ("{Username} captured").');
}

export function headlineJsxDiagnostics(): JsxHookDiagnostics[] {
    return hook?.diagnostics() ?? [];
}
