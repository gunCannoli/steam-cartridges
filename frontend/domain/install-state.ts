// Domain: an extension's install-state report (extension API 1.3.0, ADR-0107), checked and compared. Pure policy the
// app/install-state use case applies; the shape is the kernel's (`ReportedInstallState`).
import type { ReportedInstallState as InstallState } from "../kernel/extensions.ts";

export type { InstallState };

/** An extension's report, checked: anything malformed is rejected (undefined), never guessed. */
export function normalizeInstallState(raw: unknown): InstallState | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.installed !== "boolean") return undefined;
    const out: InstallState = { installed: r.installed };
    if (typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) && r.sizeBytes > 0) out.sizeBytes = Math.floor(r.sizeBytes);
    if (r.canInstall === true) out.canInstall = true;
    if (r.canUninstall === true) out.canUninstall = true;
    return out;
}

/** Equal signatures draw the same thing: no write, no redraw (guardrail 2). */
export function installStateSignature(s: InstallState | undefined): string {
    if (!s) return "-";
    return `${s.installed ? 1 : 0}|${s.sizeBytes ?? 0}|${s.canInstall ? 1 : 0}|${s.canUninstall ? 1 : 0}`;
}
