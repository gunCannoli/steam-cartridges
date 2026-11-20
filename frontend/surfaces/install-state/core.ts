// The install-state surface's Steam-facing rules and pieces that need no Steam module (node's test runner loads them,
// like native-links/core.ts). The numbers are Steam's EDisplayStatus, read from Steam's own source on 2026-11-17 (store-library
// plan phase 0 item (b)); the steam-compat check `install-state-display-status` fails if Steam renames them.
import { toShortcutId, toUnsigned } from "../../kernel/appid.ts";
import type { ReportedInstallState as InstallState } from "../../kernel/extensions.ts";

export const DISPLAY_STATUS = {
    Invalid: 0,
    Launching: 1,
    Uninstalling: 2,
    Installing: 3,
    Running: 4,
    Validating: 5,
    Updating: 6,
    Downloading: 7,
    Synchronizing: 8,
    ReadyToInstall: 9,
    ReadyToLaunch: 11,
    UpdateRequired: 20,
    Terminating: 36,
} as const;

/** States Steam is in the middle of: never overwritten (a game launching or running stays as Steam says). */
const BUSY: ReadonlySet<number> = new Set([
    DISPLAY_STATUS.Launching,
    DISPLAY_STATUS.Uninstalling,
    DISPLAY_STATUS.Installing,
    DISPLAY_STATUS.Running,
    DISPLAY_STATUS.Validating,
    DISPLAY_STATUS.Updating,
    DISPLAY_STATUS.Downloading,
    DISPLAY_STATUS.Synchronizing,
    DISPLAY_STATUS.Terminating,
]);

export function isBusy(displayStatus: unknown): boolean {
    return typeof displayStatus === "number" && BUSY.has(displayStatus);
}

/** The fields of one per-client object. */
export interface PerClientFields {
    installed: boolean;
    display_status: number;
    status_percentage: number;
}

/**
 * What a per-client object should say, or undefined to leave it as Steam wrote it: no state (not ours), a busy state
 * (launching, running, ...), or already right.
 */
export function perClientTarget(state: InstallState | undefined, current: Partial<PerClientFields> | undefined): PerClientFields | undefined {
    if (!state) return undefined;
    if (isBusy(current?.display_status)) return undefined;
    const want: PerClientFields = state.installed
        ? { installed: true, display_status: DISPLAY_STATUS.ReadyToLaunch, status_percentage: 100 }
        : { installed: false, display_status: DISPLAY_STATUS.ReadyToInstall, status_percentage: 0 };
    if (current && current.installed === want.installed && current.display_status === want.display_status && current.status_percentage === want.status_percentage)
        return undefined;
    return want;
}

/** The app-details fields Steam's play bar reads ("Space required"), or undefined when they already say it. */
export function detailsTarget(
    state: InstallState | undefined,
    current: { bHasAnyLocalContent?: unknown; lDiskSpaceRequiredBytes?: unknown } | undefined,
): { bHasAnyLocalContent: boolean; lDiskSpaceRequiredBytes: number | undefined } | undefined {
    if (!state || !current) return undefined;
    const want = state.installed
        ? { bHasAnyLocalContent: true, lDiskSpaceRequiredBytes: undefined }
        : { bHasAnyLocalContent: false, lDiskSpaceRequiredBytes: state.sizeBytes };
    if (current.bHasAnyLocalContent === want.bHasAnyLocalContent && current.lDiskSpaceRequiredBytes === want.lDiskSpaceRequiredBytes) return undefined;
    return want;
}

/** Split a Steam install / uninstall request (a multi-select can mix games): ours go to the handler, the rest to Steam. */
export function splitRequest(appids: readonly number[], isOurs: (appid: number) => boolean): { ours: number[]; steam: number[] } {
    const ours: number[] = [];
    const steam: number[] = [];
    for (const a of appids) (isOurs(a) ? ours : steam).push(a);
    return { ours, steam };
}


type AnyObj = Record<string, any>;

export interface RouterDeps {
    enabled(): boolean;
    stateOf(appid: number): InstallState | undefined;
    /** True when the extension's handler took it. */
    request(kind: "install" | "uninstall", appid: number): boolean;
    reportError(err: unknown): void;
    /** Counters for the diagnostics. */
    onRouted?(n: number): void;
    onPassed?(n: number): void;
}

/**
 * A replacement for `SteamClient.Installs.OpenInstallWizard` / `OpenUninstallWizard` (ids, ...rest): the appids we draw
 * go to the extension, Steam keeps the rest (a multi-select can mix them). Off, or nothing of ours in the list: Steam's
 * call exactly as it came. A throw falls back to Steam's call (fail-open).
 */
export function makeInstallRouter(
    original: (...a: unknown[]) => unknown,
    kind: "install" | "uninstall",
    d: RouterDeps,
): (this: unknown, ids: unknown, ...rest: unknown[]) => unknown {
    return function (this: unknown, ids: unknown, ...rest: unknown[]): unknown {
        if (!d.enabled() || !Array.isArray(ids)) return original.call(this, ids, ...rest);
        try {
            const { ours, steam } = splitRequest(ids as number[], (a) => toShortcutId(a) !== undefined && d.stateOf(a) !== undefined);
            if (ours.length === 0) return original.call(this, ids, ...rest);
            let routed = 0;
            for (const a of ours) if (d.request(kind, toUnsigned(a)!)) routed++;
            d.onRouted?.(routed);
            if (steam.length > 0) {
                d.onPassed?.(steam.length);
                return original.call(this, steam, ...rest);
            }
            return undefined;
        } catch (err) {
            d.reportError(err);
            return original.call(this, ids, ...rest);
        }
    };
}

/** Write a state into an overview's per-client objects in place (Steam's incoming object). True when anything changed. */
export function writeOverview(o: AnyObj, state: InstallState): boolean {
    const list: AnyObj[] = Array.isArray(o?.per_client_data) ? o.per_client_data : [];
    let wrote = false;
    for (const p of list) {
        if (!p || typeof p !== "object") continue;
        const t = perClientTarget(state, p);
        if (t) {
            Object.assign(p, t);
            wrote = true;
        }
    }
    return wrote;
}

/**
 * A clone of an overview with its own per-client objects saying `state` (Steam's OnCloudStorageChanged pattern), or
 * undefined when the overview already says it (no redraw).
 */
export function cloneOverview(ov: AnyObj, state: InstallState): AnyObj | undefined {
    const pcd: AnyObj[] = Array.isArray(ov?.per_client_data) ? ov.per_client_data : [];
    if (!pcd.some((p) => perClientTarget(state, p))) return undefined;
    const clone: AnyObj = new (ov.constructor as new () => AnyObj)();
    Object.assign(clone, ov);
    clone.per_client_data = pcd.map((p) => ({ ...p, ...(perClientTarget(state, p) ?? {}) }));
    return clone;
}
