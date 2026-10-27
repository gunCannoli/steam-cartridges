// app/session-memo: "ask the backend once per shortcut per session", shared by the app/ resolvers (M10).
// A final answer (ok, unsupported) is remembered for the session; anything else (pending, needs-setup,
// error) is asked again on the next view. Whether that costs any network is the backend's decision
// (fresh_policy.lua TTLs, including its 30-minute error memory): the frontend keeps no retry timer.
// One call in flight per shortcut.
import type { ShortcutId } from "../kernel/appid";
import type { Part } from "../kernel/record";

export interface SessionMemo<T> {
    /**
     * `resolve()` unless this shortcut already has a final answer stored (then `cached()`), or joins the call in flight.
     * A final answer with nothing stored resolves again: the write behind it can vanish (`records.update` is a silent
     * no-op before the base record exists, e.g. a background resolve before the first view; a forget drops the parts).
     */
    run(appid: ShortcutId, resolve: () => Promise<Part<T>>, cached: () => Part<T> | undefined): Promise<Part<T>>;
    /** Forget this shortcut: the next run resolves again. */
    forget(appid: ShortcutId): void;
}

const isFinal = (status: string) => status === "ok" || status === "unsupported";

export function createSessionMemo<T>(): SessionMemo<T> {
    const done = new Set<ShortcutId>();
    const inflight = new Map<ShortcutId, Promise<Part<T>>>();
    return {
        run(appid, resolve, cached) {
            if (done.has(appid)) {
                const hit = cached();
                if (hit !== undefined) return Promise.resolve(hit);
                // Final answer, nothing stored: resolve again instead of pending forever (see the interface note).
                done.delete(appid);
            }
            const existing = inflight.get(appid);
            if (existing) return existing;
            const promise = resolve()
                .then((part) => {
                    if (isFinal(part.status)) done.add(appid);
                    return part;
                })
                .finally(() => inflight.delete(appid));
            inflight.set(appid, promise);
            return promise;
        },
        forget(appid) {
            done.delete(appid);
            inflight.delete(appid);
        },
    };
}
