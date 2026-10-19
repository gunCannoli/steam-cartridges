// Kernel: the Surface contract and its isolation runner (migration plan M1/M3, ADR-0039).
// A surface is the only kind of code allowed to write into Steam. The runner installs
// each surface in isolation, counts its errors, and switches it off for the session
// once it exceeds its budget, so Steam falls back to stock for that view.
import type { ShortcutId } from "./appid";
import type { GameRecord, RecordPart } from "./record";

export interface Surface {
    /** Stable id, also the kill-switch id in the `disabledFeatures` setting. */
    id: string;
    /** Steam targets this surface writes or patches; no two surfaces may share one. */
    touches: string[];
    /** Record parts this surface renders; it is re-rendered only when one changes. */
    reads: RecordPart[];
    /** Resolve Steam modules once and install patches. Never called twice. */
    install(): void;
    /** Idempotent: write the record's data into Steam's stores. Never from inside a Steam render. */
    render(appid: ShortcutId, record: GameRecord | undefined): void;
    /** Undo per-app state. Never deletes StoreItemCache stubs (guardrail 5). */
    clear(appid: ShortcutId): void;
    uninstall(): void;
}

/**
 * What every surface is given by the composition root (migration plan § 7.0 D6): the
 * kill switches and the error counter of safety/, by FeatureId. A surface checks
 * isEnabled(id) at the top of every hook it installs and reports from its fail-open catch.
 */
export interface SurfaceDeps {
    isEnabled(id: string): boolean;
    reportError(id: string, err: unknown): void;
}

export interface SurfaceStatus {
    id: string;
    installed: boolean;
    disabled: boolean;
    errors: number;
    lastError?: string;
}

export interface SurfaceRunnerOptions {
    /** Ids switched off by the user or safe mode; checked before install. */
    isEnabled: (id: string) => boolean;
    /** Errors per surface per session before it is uninstalled. */
    errorBudget?: number;
    log?: (level: "warn" | "error", message: string, err?: unknown) => void;
}

export interface SurfaceRunner {
    register(surface: Surface): void;
    installAll(): void;
    render(appid: ShortcutId, record: GameRecord | undefined, changed?: RecordPart[]): void;
    clear(appid: ShortcutId): void;
    /** Surfaces call this from their own fail-open catch blocks. */
    reportError(id: string, err: unknown): void;
    status(): SurfaceStatus[];
}

/** Throws if two surfaces declare the same Steam target (ADR-0039: one owner per target). */
export function assertDisjointTouches(surfaces: Pick<Surface, "id" | "touches">[]): void {
    const owner = new Map<string, string>();
    for (const s of surfaces) {
        for (const t of s.touches) {
            const prev = owner.get(t);
            if (prev && prev !== s.id) throw new Error(`Steam target "${t}" is touched by both "${prev}" and "${s.id}"`);
            owner.set(t, s.id);
        }
    }
}

export function createSurfaceRunner(opts: SurfaceRunnerOptions): SurfaceRunner {
    const budget = opts.errorBudget ?? 5;
    const log = opts.log ?? (() => {});
    const surfaces: Surface[] = [];
    const state = new Map<string, SurfaceStatus>();

    const fail = (s: Surface, err: unknown) => {
        const st = state.get(s.id)!;
        st.errors++;
        st.lastError = String(err).slice(0, 300);
        log("warn", `Surface "${s.id}" error ${st.errors}/${budget}`, err);
        if (st.errors >= budget && !st.disabled) {
            st.disabled = true;
            log("error", `Surface "${s.id}" exceeded its error budget; switched off until Steam restarts.`);
            if (st.installed) {
                try {
                    s.uninstall();
                } catch (e) {
                    log("error", `Surface "${s.id}" failed to uninstall`, e);
                }
                st.installed = false;
            }
        }
    };
    const active = (s: Surface) => {
        const st = state.get(s.id)!;
        return st.installed && !st.disabled;
    };

    return {
        register(surface) {
            if (state.has(surface.id)) throw new Error(`Surface "${surface.id}" registered twice`);
            assertDisjointTouches([...surfaces, surface]);
            surfaces.push(surface);
            state.set(surface.id, { id: surface.id, installed: false, disabled: false, errors: 0 });
        },
        installAll() {
            for (const s of surfaces) {
                const st = state.get(s.id)!;
                if (st.installed || st.disabled) continue;
                if (!opts.isEnabled(s.id)) {
                    st.disabled = true;
                    continue;
                }
                try {
                    s.install();
                    st.installed = true;
                } catch (err) {
                    fail(s, err);
                }
            }
        },
        render(appid, record, changed) {
            for (const s of surfaces) {
                if (!active(s)) continue;
                if (changed && !changed.some((p) => s.reads.includes(p))) continue;
                try {
                    s.render(appid, record);
                } catch (err) {
                    fail(s, err);
                }
            }
        },
        clear(appid) {
            for (const s of surfaces) {
                if (!active(s)) continue;
                try {
                    s.clear(appid);
                } catch (err) {
                    fail(s, err);
                }
            }
        },
        reportError(id, err) {
            const s = surfaces.find((x) => x.id === id);
            if (s) fail(s, err);
        },
        status: () => surfaces.map((s) => ({ ...state.get(s.id)! })),
    };
}
