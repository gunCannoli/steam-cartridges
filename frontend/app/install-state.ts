// app/install-state: what extensions report about a shortcut's install state, and where Steam's Install / Uninstall for
// it goes (extension API 1.3.0, ADR-0107, store-library plan § 4.1). Memory only: an extension reports again at start-up.
// The install-state surface draws it; this use case never touches Steam. A shortcut another plugin manages (ADR-0109,
// steam-epic-games) is never taken, so two plugins never write the same overview.
import { toShortcutId, type ShortcutId } from "../kernel/appid.ts";
import type { EventBus } from "../kernel/events.ts";
import type { InstallHandler, ReportOptions } from "../kernel/extensions.ts";
import { installStateSignature, normalizeInstallState, type InstallState } from "../domain/install-state.ts";

export interface InstallStateDeps {
    bus: Pick<EventBus, "emit">;
    /** The plugin that manages this shortcut itself, if any (index.tsx: domain/merged-plugins ownerOf). */
    ownerOf(appid: number): string | undefined;
    /** One line for the plugin log. */
    log(message: string): void;
}

export interface InstallStateService {
    report(appid: number, state: unknown, opts: ReportOptions): Promise<{ ok: boolean }>;
    registerHandler(handler: InstallHandler): () => void;
    /** The state to draw, or undefined (not reported, or managed by another plugin now). Hot path: one Map lookup. */
    stateOf(appid: number): InstallState | undefined;
    /** Every appid with a state to draw. */
    reported(): ShortcutId[];
    /** Steam's Install / Uninstall for an appid we draw: true when the handler took it (Steam's wizard must not open). */
    request(kind: "install" | "uninstall", appid: number): boolean;
    /** The extension no longer owns the shortcut (forgetGame): Steam's own state comes back. */
    forget(appid: number, providerId?: string): void;
    counts(): { reported: number; notInstalled: number; handlers: number };
    /** Anything reported at all (the surface's hot-path early-out). */
    hasAny(): boolean;
}

interface Entry {
    state: InstallState;
    providerId: string;
    sig: string;
}

export function createInstallState(deps: InstallStateDeps): InstallStateService {
    const entries = new Map<ShortcutId, Entry>();
    const handlers = new Map<string, InstallHandler>();

    const live = (id: ShortcutId): Entry | undefined => {
        const e = entries.get(id);
        if (!e) return undefined;
        return deps.ownerOf(id) ? undefined : e;
    };

    return {
        async report(appid, raw, opts) {
            const id = toShortcutId(appid);
            const providerId = typeof opts?.providerId === "string" && opts.providerId !== "" ? opts.providerId : undefined;
            const state = normalizeInstallState(raw);
            if (id === undefined || !providerId || !state) {
                deps.log(`rejected a report from ${providerId ?? "an extension"}: ${id === undefined ? "not a shortcut appid" : !state ? "malformed state" : "no providerId"}`);
                return { ok: false };
            }
            const owner = deps.ownerOf(id);
            if (owner) {
                deps.log(`${providerId} reported ${id}, managed by ${owner}: left alone`);
                return { ok: false };
            }
            const sig = installStateSignature(state);
            const prev = entries.get(id);
            if (prev && prev.sig === sig && prev.providerId === providerId) return { ok: true };
            entries.set(id, { state, providerId, sig });
            deps.log(`${providerId} ${id} installed=${state.installed} size=${state.sizeBytes ? "yes" : "no"} canInstall=${state.canInstall === true}`);
            deps.bus.emit("install-state.changed", { appid: id, drawn: true });
            return { ok: true };
        },
        registerHandler(handler) {
            handlers.set(handler.id, handler);
            deps.log(`handler ${handler.id} registered`);
            return () => {
                if (handlers.get(handler.id) === handler) handlers.delete(handler.id);
            };
        },
        stateOf(appid) {
            const id = toShortcutId(appid);
            return id === undefined ? undefined : live(id)?.state;
        },
        reported() {
            return [...entries.keys()].filter((id) => live(id) !== undefined);
        },
        request(kind, appid) {
            const id = toShortcutId(appid);
            const e = id === undefined ? undefined : live(id);
            if (!e) return false;
            const h = handlers.get(e.providerId);
            const fn = kind === "install" ? h?.install : h?.uninstall;
            if (!h || typeof fn !== "function") {
                // Ours, but nobody can act on it: still never Steam's wizard (it would try to download a shortcut).
                deps.log(`${kind} ${id}: no handler from ${e.providerId}`);
                return true;
            }
            const done = (ok: boolean, why = "") => deps.log(`${kind}-request ${id} via ${e.providerId} ok=${ok}${why}`);
            try {
                Promise.resolve(fn.call(h, id as number))
                    .then((r) => done(r?.ok === true))
                    .catch((err) => done(false, ` (${String(err).slice(0, 80)})`));
            } catch (err) {
                done(false, ` (${String(err).slice(0, 80)})`);
            }
            return true;
        },
        forget(appid, providerId) {
            const id = toShortcutId(appid);
            if (id === undefined) return;
            const e = entries.get(id);
            if (!e || (providerId && e.providerId !== providerId)) return;
            entries.delete(id);
            deps.log(`${e.providerId} ${id} forgotten`);
            deps.bus.emit("install-state.changed", { appid: id, drawn: false });
        },
        counts() {
            let notInstalled = 0;
            for (const id of entries.keys()) if (live(id)?.state.installed === false) notInstalled++;
            return { reported: entries.size, notInstalled, handlers: handlers.size };
        },
        hasAny: () => entries.size > 0,
    };
}
