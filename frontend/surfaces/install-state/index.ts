// Surface `install-state` (ADR-0107, store-library plan § 4.1): draws Steam's own not-installed state for the shortcuts an
// extension reports (extension API 1.3.0), and routes Steam's Install / Uninstall for them to that extension. Nothing is
// drawn by us: Steam greys the tile, drops the game from the Installed collection and shows Install on the play bar from
// the fields written here. A shortcut nobody reports is never touched (with no expansion, nothing changes).
//
// What Steam does (phase 0 probe, tests/live/probes/install_state.mjs, 2026-11-17):
// - `installed` / `display_status` / `status_percentage` are getters over the overview's plain per-client objects
//   (`per_client_data[]`; `installed` reads `most_available_per_client_data`, `local_per_client_data` is clientid "0"). Steam replaces the whole overview on every change,
//   so the write happens inside `collectionStore.OnAppOverviewChange` (its prototype method; incoming overviews in arg 0).
// - An overview Steam already holds is corrected Steam's own way (appStore.OnCloudStorageChanged): a clone with its own
//   per-client objects, `appStore.m_mapApps.set`, then `OnAppOverviewChange([clone], [])` so collections regroup. Steam's
//   objects are never mutated after the fact, and the clone is a full copy of a real overview, never a sparse stub
//   (knowledgebase "m_mapApps").
// - App details: `appDetailsStore.AppDetailsChanged` is an own bound MobX action, **non-writable and non-configurable** (it
//   cannot be patched; trying threw at start-up, 2026-11-17). Steam hands it to `SteamClient.Apps.RegisterForAppDetails`
//   when it first subscribes an app, so the callback is wrapped there (read at call time): later subscriptions see our
//   fields. A state change pushes a full copy of Steam's own details through `AppDetailsChanged` (calling it is fine;
//   guardrail 8 forbids a synthetic `details`, not Steam's own object passed back).
// - `SteamClient.Installs.OpenInstallWizard` / `OpenUninstallWizard` are read at call time by Steam's 6 callers: replacing
//   the property routes them. A multi-select is split: Steam keeps its own appids.
import { beforePatch } from "@steambrew/client";
import { toShortcutId } from "../../kernel/appid";
import type { EventBus } from "../../kernel/events";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import type { ReportedInstallState as InstallState } from "../../kernel/extensions";
import { cloneOverview, detailsTarget, makeInstallRouter, writeOverview } from "./core";

export const INSTALL_STATE_ID = "install-state";

/**
 * ADR-0044: pure reads of app/install-state, and the bus for this surface's own events (`install-state.requested`: Steam's
 * Install / Uninstall for an appid we draw, which app/install-state hands to the extension; `surface.report`: its log line).
 */
export interface InstallStateSurfaceDeps extends SurfaceDeps {
    bus: Pick<EventBus, "on" | "emit">;
    stateOf(appid: number): InstallState | undefined;
    reported(): number[];
    /** True when anything is reported at all: the overview hook's early-out (guardrail 2). */
    hasAny(): boolean;
}

type AnyObj = Record<string, any>;
const g = () => window as unknown as AnyObj;

export interface InstallStateSurface extends Surface {
    diagnostics(): { installed: boolean; shape: string; hookWrites: number; redraws: number; detailWrites: number; routed: number; passed: number };
}

export function createInstallStateSurface(d: InstallStateSurfaceDeps): InstallStateSurface {
    const enabled = () => d.isEnabled(INSTALL_STATE_ID);
    const log = (message: string) => d.bus.emit("surface.report", { area: INSTALL_STATE_ID, message });
    const stats = { installed: false, shape: "not checked", hookWrites: 0, redraws: 0, detailWrites: 0, routed: 0, passed: 0 };
    /** Shortcuts we drew not-installed: when their report goes away, Steam's installed state is drawn back. */
    const drawnOff = new Set<number>();
    const pending = new Set<number>();
    const unpatch: (() => void)[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    /** The state to draw for an appid: its report, or "installed" once to undo what we drew. */
    const targetOf = (appid: number): InstallState | undefined => d.stateOf(appid) ?? (drawnOff.has(appid) ? { installed: true } : undefined);

    const redraw = (appid: number): void => {
        const appStore = g().appStore;
        const collectionStore = g().collectionStore;
        const state = targetOf(appid);
        if (!state || !appStore || !collectionStore) return;
        const ov: AnyObj | undefined = appStore.GetAppOverviewByAppID?.(appid);
        const clone = ov ? cloneOverview(ov, state) : undefined;
        if (clone) {
            appStore.m_mapApps.set(appid, clone);
            collectionStore.OnAppOverviewChange([clone], []);
            stats.redraws++;
        }
        const details: AnyObj | undefined = g().appDetailsStore?.GetAppDetails?.(appid);
        const dt = detailsTarget(state, details);
        if (details && dt) {
            g().appDetailsStore.AppDetailsChanged({ ...details, ...dt });
            stats.detailWrites++;
        }
        if (state.installed) drawnOff.delete(appid);
        else drawnOff.add(appid);
    };

    const flush = (): void => {
        flushTimer = undefined;
        if (!enabled() || !stats.installed) return;
        const ids = [...pending];
        pending.clear();
        for (const id of ids) {
            try {
                redraw(id);
            } catch (err) {
                d.reportError(INSTALL_STATE_ID, err); // fail-open: Steam keeps what it had
            }
        }
    };
    const schedule = (appid: number): void => {
        pending.add(appid);
        if (!flushTimer) flushTimer = setTimeout(flush, 0); // never from inside a Steam call (plan § 7.0 D5)
    };

    /** The shape the writes rely on; anything else leaves the surface off with one line (guardrail 25). */
    const checkShape = (): string | undefined => {
        const cs = g().collectionStore;
        const as = g().appStore;
        const ds = g().appDetailsStore;
        const inst = g().SteamClient?.Installs;
        if (typeof Object.getPrototypeOf(cs ?? {})?.OnAppOverviewChange !== "function") return "collectionStore.OnAppOverviewChange";
        if (typeof as?.m_mapApps?.set !== "function" || typeof as?.GetAppOverviewByAppID !== "function") return "appStore.m_mapApps";
        if (typeof ds?.AppDetailsChanged !== "function" || typeof ds?.GetAppDetails !== "function") return "appDetailsStore.AppDetailsChanged";
        if (typeof inst?.OpenInstallWizard !== "function" || typeof inst?.OpenUninstallWizard !== "function") return "SteamClient.Installs";
        const writable = (o: AnyObj | undefined, k: string) => {
            const desc = o ? Object.getOwnPropertyDescriptor(o, k) : undefined;
            return !!desc && desc.writable === true && typeof desc.value === "function";
        };
        if (!writable(inst, "OpenInstallWizard") || !writable(inst, "OpenUninstallWizard")) return "SteamClient.Installs not writable";
        if (!writable(g().SteamClient?.Apps, "RegisterForAppDetails")) return "SteamClient.Apps.RegisterForAppDetails not writable";
        const oac = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cs), "OnAppOverviewChange");
        if (!oac || oac.writable !== true) return "collectionStore.OnAppOverviewChange not writable";
        // `allApps` is a getter that throws inside Steam while the library is still loading (start-up, 2026-11-17: "reading
        // 'get'"): the per-overview check is then skipped; the hook itself never trusts the shape (writeOverview).
        let sample: AnyObj | undefined;
        try {
            sample = cs?.allAppsCollection?.allApps?.find?.((a: AnyObj) => Array.isArray(a?.per_client_data) && a.per_client_data.length > 0);
        } catch {
            sample = undefined;
        }
        if (sample) {
            let p: AnyObj | null = sample;
            let desc: PropertyDescriptor | undefined;
            while (p && !(desc = Object.getOwnPropertyDescriptor(p, "installed"))) p = Object.getPrototypeOf(p);
            if (!desc?.get) return "AppOverview.installed is no longer a getter";
            // `installed` reads most_available_per_client_data, `local_per_client_data` is the entry with clientid "0"
            // (not always the first): every entry is written, so only "it is one of them" is checked.
            if (sample.local_per_client_data && !sample.per_client_data.includes(sample.local_per_client_data)) return "AppOverview.local_per_client_data";
        }
        return undefined;
    };

    const routeInstalls = (): void => {
        const inst = g().SteamClient.Installs as AnyObj;
        for (const [name, kind] of [["OpenInstallWizard", "install"], ["OpenUninstallWizard", "uninstall"]] as const) {
            const original = inst[name] as (...a: unknown[]) => unknown;
            const wrapper = makeInstallRouter(original, kind, {
                enabled,
                stateOf: d.stateOf,
                // never Steam's wizard for an appid we draw: app/install-state takes it (the extension's handler)
                request: (k, appid) => {
                    d.bus.emit("install-state.requested", { appid, kind: k });
                    return true;
                },
                reportError: (err) => d.reportError(INSTALL_STATE_ID, err),
                onRouted: (n) => (stats.routed += n),
                onPassed: (n) => (stats.passed += n),
            });
            inst[name] = wrapper;
            unpatch.push(() => {
                if (inst[name] === wrapper) inst[name] = original;
            });
        }
    };

    const attach = (): void => {
        const shape = checkShape();
        if (shape) {
            stats.shape = `changed: ${shape}`;
            log(`shape changed (${shape}): left off, Steam draws every shortcut as installed`);
            return;
        }
        stats.shape = "ok";
        try {
            patchAll();
        } catch (err) {
            // all or nothing: a half-installed surface (overview hook without routing) would grey a game Install cannot fix
            for (const u of unpatch.splice(0)) {
                try {
                    u();
                } catch {}
            }
            stats.shape = `patch failed: ${String(err).slice(0, 80)}`;
            log(`patch failed (${String(err).slice(0, 120)}): left off`);
            throw err;
        }
        stats.installed = true;
        const ids = d.reported();
        for (const id of ids) schedule(id);
        log(`ready: overview hook, details callback, install routing; ${ids.length} reported at start`);
    };

    const patchAll = (): void => {
        const cs = g().collectionStore;
        const owner = Object.getPrototypeOf(cs);
        const p1 = beforePatch(owner, "OnAppOverviewChange", (args: unknown[]) => {
            if (!enabled() || !d.hasAny()) return;
            try {
                const list = args[0];
                if (!Array.isArray(list)) return;
                for (const o of list) {
                    const id = toShortcutId((o as AnyObj)?.appid);
                    if (id === undefined) continue;
                    const state = d.stateOf(id);
                    if (state && !state.installed && writeOverview(o as AnyObj, state)) stats.hookWrites++;
                }
            } catch (err) {
                d.reportError(INSTALL_STATE_ID, err); // fail-open: Steam's overview as it came
            }
        });
        unpatch.push(() => p1.unpatch());
        const apps = g().SteamClient.Apps as AnyObj;
        const register = apps.RegisterForAppDetails as (...a: unknown[]) => unknown;
        const fixDetails = (det: AnyObj | undefined): void => {
            if (!enabled() || !d.hasAny()) return;
            try {
                const id = toShortcutId(det?.unAppID);
                if (id === undefined) return;
                const state = d.stateOf(id);
                const t = state && !state.installed ? detailsTarget(state, det) : undefined;
                if (det && t) Object.assign(det, t);
            } catch (err) {
                d.reportError(INSTALL_STATE_ID, err); // fail-open: Steam's details as they came
            }
        };
        const registerWrapper = function (this: unknown, appid: unknown, cb: unknown, ...rest: unknown[]): unknown {
            if (typeof cb !== "function" || toShortcutId(appid) === undefined) return register.call(this, appid, cb, ...rest);
            const wrapped = function (this: unknown, det: unknown, ...more: unknown[]): unknown {
                fixDetails(det as AnyObj);
                return (cb as (...a: unknown[]) => unknown).call(this, det, ...more);
            };
            return register.call(this, appid, wrapped, ...rest);
        };
        apps.RegisterForAppDetails = registerWrapper;
        unpatch.push(() => {
            if (apps.RegisterForAppDetails === registerWrapper) apps.RegisterForAppDetails = register;
        });
        routeInstalls();
    };

    return {
        id: INSTALL_STATE_ID,
        touches: [
            // independent listeners on methods library-home and game-info also patch: named apart (ADR-0039)
            "collectionStore.OnAppOverviewChange#install-state",
            "SteamClient.Apps.RegisterForAppDetails",
            "appStore.m_mapApps#install-state",
            "SteamClient.Installs.OpenInstallWizard",
            "SteamClient.Installs.OpenUninstallWizard",
        ],
        reads: [],
        install() {
            d.bus.on("install-state.changed", ({ appid }) => schedule(appid));
            let tries = 0;
            const attempt = () => {
                if (!g().collectionStore || !g().appStore || !g().appDetailsStore) {
                    if (++tries < 40) setTimeout(attempt, 500);
                    else log("Steam's stores never appeared: left off");
                    return;
                }
                try {
                    attach();
                } catch (err) {
                    d.reportError(INSTALL_STATE_ID, err);
                }
            };
            attempt();
        },
        render() {
            /* driven by install-state.changed, not by the record */
        },
        clear() {
            /* a shortcut's state goes with its report (app/install-state forget) */
        },
        uninstall() {
            // Undo the routing first (a stale wrapper would swallow Install), then redraw Steam's own state.
            for (const u of unpatch.splice(0)) {
                try {
                    u();
                } catch {}
            }
            stats.installed = false;
            const back = [...drawnOff];
            drawnOff.clear();
            for (const id of back) {
                try {
                    const ov = g().appStore?.GetAppOverviewByAppID?.(id);
                    const clone = ov ? cloneOverview(ov, { installed: true }) : undefined;
                    if (!clone) continue;
                    g().appStore.m_mapApps.set(id, clone);
                    g().collectionStore.OnAppOverviewChange([clone], []);
                } catch {}
            }
        },
        diagnostics: () => ({ ...stats }),
    };
}
