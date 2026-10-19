import { beforePatch, callOriginal, replacePatch } from '@steambrew/client';

/**
 * A self-healing patch on Steam's shared `react/jsx-runtime` (`jsx` / `jsxs`),
 * safe to use from several plugins at once.
 *
 * SAME FILE in every plugin that hooks jsx (steam-cartridges,
 * enhanced-notifications); plugins may not import each other, so keep the copies
 * identical. Design: docs/plugins.md, "Sharing the jsx runtime between plugins".
 *
 * Why: each plugin used to re-patch whenever `runtime.jsx` was not its own
 * function. With two such plugins, each saw the other on top and wrapped again
 * every 5 s, so the chain grew without bound. Here the check is "is my patch
 * anywhere in the chain?" instead of "am I on top?":
 *
 * 1. Patches are made with the SDK patcher, which links each wrapper to the next
 *    through `fn.__millenniumPatch.original`, so the chain can be walked.
 * 2. If the walk hits a foreign wrapper without that link, a sentinel probe
 *    (`runtime.jsx(SENTINEL, {})`) checks whether calls still reach our handler.
 * 3. Only if neither finds it is the patch re-installed.
 *
 * When: on a 5 s timer, and within a microtask of any write to `jsx`/`jsxs`
 * (the write guard below). The guard exists because Millennium itself drops
 * every plugin's patch: its FCTrampoline swaps `SP_JSX_FACTORY.jsx`/`jsxs` for
 * stubs while rendering some components (every toast window does), then
 * "removes stubs" by restoring a copy it took when the trampoline was created,
 * before any plugin patched (verified live 2026-09-25, docs/plugins.md). With
 * only the timer, anything rendered in the next ≤5 s lost our patch; a queued
 * achievement banner re-rendered by the toast stack fell back to Steam's toast.
 *
 * Handlers run for every element in the client (guardrail 2): keep them O(1).
 */

type JsxFn = (type: unknown, props: unknown, key?: unknown) => unknown;
type Runtime = Record<'jsx' | 'jsxs', JsxFn>;
type Patched = JsxFn & { __millenniumPatch?: { original?: JsxFn } };

export interface JsxHookDiagnostics {
    label: string;
    installs: number;
    live: boolean;
    /** SDK-linked wrappers walked from the top before finding ours (or reaching the end). */
    chainDepth: number;
    /** The walk could not find ours, so a sentinel probe decided liveness (foreign wrapper on top). */
    probed: boolean;
}

export interface JsxHookOptions {
    label: string;
    /** Observe only (never changes the element). */
    observe?: (type: unknown, props: unknown) => void;
    /** Return a replacement element type, or undefined to leave the element alone. */
    replaceType?: (type: unknown, props: unknown) => unknown;
    intervalMs?: number;
}

const SENTINEL = function EnhancedPluginsJsxSentinel() {
    return null;
};

const GUARD_KEY = '__enhancedPluginsJsxGuard';

interface WriteGuard {
    /** Called (batched, in a microtask) after any write to `jsx` or `jsxs`. */
    onWrite: Set<() => void>;
}

/**
 * Turn `runtime.jsx`/`jsxs` into accessors that behave exactly like the plain
 * properties (the getter returns what was last set, so the SDK patcher and
 * Millennium work unchanged) but tell every registered plugin after a write.
 * The check runs in a microtask, never inside the setter: the SDK patcher
 * attaches `__millenniumPatch` to the new function *after* assigning it, so
 * the chain is only walkable once the writer's synchronous code is done.
 *
 * One guard per runtime, shared by every plugin that has this file (stored on
 * the runtime itself). Returns null when the properties cannot take an
 * accessor; the 5 s timer then still heals, just later.
 *
 * The getter is on the hot path of every element Steam creates: it only
 * returns a closure variable (O(1), guardrail 2).
 */
function writeGuard(runtime: Runtime): WriteGuard | null {
    const holder = runtime as unknown as Record<string, WriteGuard | undefined>;
    if (holder[GUARD_KEY]) return holder[GUARD_KEY]!;
    const names = ['jsx', 'jsxs'] as const;
    const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(runtime, name));
    if (descriptors.some((d) => !d || !d.configurable || d.get || d.set || typeof d.value !== 'function')) return null;

    const guard: WriteGuard = { onWrite: new Set() };
    let pending = false;
    const notify = () => {
        pending = false;
        for (const fn of guard.onWrite) {
            try {
                fn();
            } catch {
                /* one plugin's heal must not stop another's */
            }
        }
    };
    names.forEach((name, i) => {
        let value = descriptors[i]!.value as JsxFn;
        Object.defineProperty(runtime, name, {
            configurable: true,
            enumerable: descriptors[i]!.enumerable,
            get: () => value,
            set: (next: JsxFn) => {
                value = next;
                if (!pending) {
                    pending = true;
                    queueMicrotask(notify);
                }
            },
        });
    });
    Object.defineProperty(runtime, GUARD_KEY, { value: guard });
    return guard;
}

/** Walk SDK patch links from the top; stops at the base or at a foreign (non-SDK) wrapper. */
function walk(top: Patched | undefined, target: Patched | undefined): { found: boolean; depth: number } {
    let depth = 0;
    for (let f = top; f && depth < 64; depth++) {
        if (f === target) return { found: true, depth };
        f = f.__millenniumPatch?.original as Patched | undefined;
    }
    return { found: false, depth };
}

export function keepJsxPatched(runtime: Runtime, options: JsxHookOptions): { diagnostics(): JsxHookDiagnostics[]; dispose(): void } {
    const intervalMs = options.intervalMs ?? 5000;
    const state = {
        jsx: { patched: undefined as Patched | undefined, unpatch: undefined as (() => void) | undefined, installs: 0, probed: false },
        jsxs: { patched: undefined as Patched | undefined, unpatch: undefined as (() => void) | undefined, installs: 0, probed: false },
    };

    function install(name: 'jsx' | 'jsxs'): void {
        const s = state[name];
        const patch: { original: JsxFn; unpatch(): void } = options.replaceType
            ? replacePatch(runtime, name, function (this: unknown, args: unknown[]): unknown {
                  if (args[0] === SENTINEL) {
                      s.probed = true;
                      return callOriginal;
                  }
                  const replacement = options.replaceType!(args[0], args[1]);
                  if (replacement === undefined) return callOriginal;
                  return patch.original.call(this, replacement, args[1], args[2]);
              })
            : beforePatch(runtime, name, (args: unknown[]) => {
                  if (args[0] === SENTINEL) {
                      s.probed = true;
                      return;
                  }
                  options.observe?.(args[0], args[1]);
              });
        s.patched = runtime[name] as Patched;
        s.unpatch = () => patch.unpatch();
        s.installs++;
    }

    /** Walk first; if the walk ends without finding us (base or a foreign wrapper), probe. */
    function isLive(name: 'jsx' | 'jsxs'): { live: boolean; depth: number; probed: boolean } {
        const s = state[name];
        const w = walk(runtime[name] as Patched, s.patched);
        if (w.found) return { live: true, depth: w.depth, probed: false };
        s.probed = false;
        try {
            runtime[name](SENTINEL, {});
        } catch {
            /* a broken foreign wrapper: treat as not reaching us */
        }
        return { live: s.probed, depth: w.depth, probed: true };
    }

    function ensure(): void {
        for (const name of ['jsx', 'jsxs'] as const) {
            if (!state[name].patched || !isLive(name).live) install(name);
        }
    }

    ensure();
    const timer = setInterval(ensure, intervalMs);
    // Heal right after any write (e.g. Millennium restoring a stale jsx), not ≤5 s later.
    const guard = writeGuard(runtime);
    guard?.onWrite.add(ensure);

    return {
        diagnostics: () =>
            (['jsx', 'jsxs'] as const).map((name) => {
                const l = isLive(name);
                return { label: `${options.label}.${name}`, installs: state[name].installs, live: l.live, chainDepth: l.depth, probed: l.probed };
            }),
        dispose: () => {
            clearInterval(timer);
            guard?.onWrite.delete(ensure);
            for (const name of ['jsx', 'jsxs'] as const) {
                try {
                    state[name].unpatch?.();
                } catch {
                    /* already gone */
                }
            }
        },
    };
}
