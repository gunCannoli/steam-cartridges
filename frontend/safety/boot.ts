// Safety: boot sentinel (migration plan M0b, ADR-0039).
// A hung SharedJSContext cannot run any cleanup, so the sentinel works the other way
// round: every start marks the boot "pending"; a clean shutdown (pagehide) or 60 s of
// error-free running clears it. If a start finds the previous boot still pending, that
// boot ended badly. After two bad boots in a row, the plugin starts in safe mode.
// SharedJSContext's localStorage survives Steam restarts (the old sync manager relied on it too).
//
// A start that reached "ready" and then ran SURVIVED_MS with no feature error was not a crash loop, even when nothing
// cleared it: Steam closing or reloading its page often fires no pagehide (a tester's 0.6.10-beta log, 2026-11-07: the
// page started again 26 s after a clean start and the next start went to safe mode). Such a start is not counted, so safe mode
// no longer depends on the user leaving Steam open for a minute. What still counts: a start that never reached ready
// (a hang or a crash while installing), one that ended within SURVIVED_MS of ready, and one with feature errors.

export const BOOT_KEY = "steam-cartridges.boot";
/** Bad boots in a row that switch safe mode on. */
export const UNCLEAN_LIMIT = 2;
export const HEALTHY_AFTER_MS = 60_000;
/** Running this long past ready with no feature error proves the start was not a crash. */
export const SURVIVED_MS = 10_000;
/** The record's layout; an entry without it was written by 0.6.10-beta or older. */
const VERSION = 2;

export interface BootState {
    pending: boolean;
    unclean: number;
    at: number;
    v?: number;
    /** When the start reached ready (ms). */
    ready?: number;
    /** The last time the start was seen running past ready (ms). */
    alive?: number;
    /** Feature errors counted by `alive`. */
    errors?: number;
}

export type PreviousBoot =
    | { verdict: "first" }
    | { verdict: "clean" }
    /** Written by an older version: it cannot tell a crash from a reload, so it is not counted. */
    | { verdict: "legacy" }
    | { verdict: "survived"; ranMs: number }
    | { verdict: "unclean"; reachedReady: boolean; ranMs?: number; errors: number };

export interface KeyValue {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function read(store: KeyValue): BootState | undefined {
    try {
        const v = JSON.parse(store.getItem(BOOT_KEY) ?? "null");
        if (v && typeof v.pending === "boolean" && typeof v.unclean === "number") return v;
    } catch {
        /* corrupt entry: treat as a first boot */
    }
    return undefined;
}

function write(store: KeyValue, state: BootState): void {
    try {
        store.setItem(BOOT_KEY, JSON.stringify({ ...state, v: VERSION }));
    } catch {
        /* storage unavailable: the sentinel is best-effort */
    }
}

/** How the previous start ended, from its record. */
export function judgePrevious(prev: BootState | undefined): PreviousBoot {
    if (!prev) return { verdict: "first" };
    if (!prev.pending) return { verdict: "clean" };
    if (prev.v !== VERSION) return { verdict: "legacy" };
    const errors = Number(prev.errors) || 0;
    const ranMs = typeof prev.ready === "number" && typeof prev.alive === "number" ? Math.max(0, prev.alive - prev.ready) : undefined;
    if (ranMs !== undefined && ranMs >= SURVIVED_MS && errors === 0) return { verdict: "survived", ranMs };
    return { verdict: "unclean", reachedReady: typeof prev.ready === "number", ranMs, errors };
}

/** The previous start as a log phrase (no name, no path). */
export function describePrevious(p: PreviousBoot): string {
    switch (p.verdict) {
        case "first":
            return "no earlier start recorded";
        case "clean":
            return "the previous start ended cleanly";
        case "legacy":
            return "the previous start was recorded by an older version: not counted";
        case "survived":
            return `the previous start ran ${Math.round(p.ranMs / 1000)} s past ready with no error, then ended without a clean shutdown (Steam closed, or restarted its page): not counted`;
        case "unclean":
            return `the previous start ${p.reachedReady ? `ended ${p.ranMs === undefined ? "soon" : `${Math.round(p.ranMs / 1000)} s`} after ready` : "never reached ready"}${p.errors > 0 ? ` with ${p.errors} feature error(s)` : ""}: counted`;
    }
}

/** Call once at plugin start. Returns whether to start in safe mode, the bad-boot count, and how the last start ended. */
export function beginBoot(store: KeyValue, now = Date.now()): { safeMode: boolean; unclean: number; previous: PreviousBoot } {
    const prev = read(store);
    const previous = judgePrevious(prev);
    const unclean = previous.verdict === "unclean" ? (prev?.unclean ?? 0) + 1 : 0;
    write(store, { pending: true, unclean, at: now });
    return { safeMode: unclean >= UNCLEAN_LIMIT, unclean, previous };
}

/** Call after HEALTHY_AFTER_MS with no feature errors, and on a clean shutdown. */
export function markHealthy(store: KeyValue, now = Date.now()): void {
    write(store, { pending: false, unclean: 0, at: now });
}

function patch(store: KeyValue, fields: Partial<BootState>): void {
    const cur = read(store);
    // Only a pending start is updated: after pagehide or the healthy mark there is nothing to prove.
    if (!cur || !cur.pending) return;
    write(store, { ...cur, ...fields });
}

/** The start reached ready (every surface it may install is installed). */
export function markReady(store: KeyValue, now = Date.now()): void {
    patch(store, { ready: now, alive: now, errors: 0 });
}

/** The start is still running past ready, with this many feature errors. */
export function markAlive(store: KeyValue, errors: number, now = Date.now()): void {
    patch(store, { alive: now, errors });
}

/**
 * Wire the sentinel: clears on pagehide, and after the healthy delay if no errors were counted. Returns `ready()`, to call
 * when the start is ready: SURVIVED_MS later the start is recorded as alive (with its error count).
 */
export function watchBoot(
    store: KeyValue,
    errorCount: () => number,
    win: { addEventListener(type: string, fn: () => void): void; setTimeout(fn: () => void, ms: number): unknown },
): { ready(): void } {
    win.addEventListener("pagehide", () => markHealthy(store));
    win.setTimeout(() => {
        if (errorCount() === 0) markHealthy(store);
        else markAlive(store, errorCount());
    }, HEALTHY_AFTER_MS);
    return {
        ready() {
            markReady(store);
            win.setTimeout(() => markAlive(store, errorCount()), SURVIVED_MS);
        },
    };
}
