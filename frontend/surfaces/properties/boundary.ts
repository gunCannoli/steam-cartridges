// Surface `properties`: a boundary around the Cartridge page body. A render error inside our page used to reach Steam's
// own boundary and take the whole Properties dialog with it (a user's report, 2026-11-12: "crashed just by searching a
// game to link it"). Here the error stays in our page, shows one line with a Try again button, and the log gets the
// error text and the top of the component stack (no names, no paths).
import { Component, createElement, type ReactNode } from "react";

interface Props {
    appid: number;
    log?: (tag: string, message: string) => void;
    children?: ReactNode;
}
interface State {
    error?: Error;
}

/** One log line from an error: its name, message and the first frames of the component stack, trimmed. Pure. */
export function describeRenderError(error: unknown, componentStack: string | null | undefined): string {
    const e = error as { name?: unknown; message?: unknown } | undefined;
    const name = typeof e?.name === "string" ? e.name : "Error";
    const message = typeof e?.message === "string" ? e.message : String(error);
    const frames = (componentStack ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(" < ");
    return `${name}: ${message.slice(0, 200)}; components: ${frames.slice(0, 400) || "unknown"}`;
}

export class PageBoundary extends Component<Props, State> {
    override state: State = {};

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
        try {
            this.props.log?.("properties", `Cartridge page failed to render: ${describeRenderError(error, info?.componentStack)}`);
        } catch {
            // logging must never throw inside a boundary
        }
    }

    override render(): ReactNode {
        if (!this.state.error) return this.props.children;
        return createElement(
            "div",
            { style: { padding: "12px 16px", color: "#e5a00d" } },
            createElement("div", null, "The Cartridge page hit a problem and was stopped. The Properties window is fine."),
            createElement(
                "button",
                { style: { marginTop: 8 }, onClick: () => this.setState({ error: undefined }) },
                "Try again",
            ),
        );
    }
}
