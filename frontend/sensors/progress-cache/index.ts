// Sensor `progress-cache` (ADR-0045): notices when Steam's achievement progress cache map appears or is replaced.
// Steam's `LoadCacheFile` (after login) builds a new `m_achievementProgress` from its own file, which drops
// anything written before it (verified live 2026-09-30). Read-only; bounded; no Steam write.

/** Steam's progress cache map, or undefined while Steam has not created it. Compared by identity only. */
export function progressCacheMap(): unknown {
    try {
        return (window as any).appAchievementProgressCache?.m_achievementProgress?.mapCache;
    } catch {
        return undefined;
    }
}

export interface WatchOptions {
    intervalMs?: number;
    /** Stops after this long, so a user who never logs in costs nothing. */
    maxMs?: number;
    timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
}

/**
 * Calls `onChange` each time `read()` returns a defined value that differs (by identity) from the last one
 * it called for: once for the first map, again for each replacement. Returns a stop function.
 */
export function watchIdentity(read: () => unknown, onChange: () => void, opts: WatchOptions = {}): () => void {
    const intervalMs = opts.intervalMs ?? 1000;
    const maxTicks = Math.ceil((opts.maxMs ?? 10 * 60 * 1000) / intervalMs);
    const timers = opts.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as any) };
    let last: unknown;
    let ticks = 0;
    const tick = () => {
        ticks++;
        const now = read();
        if (now !== undefined && now !== null && now !== last) {
            last = now;
            onChange();
        }
        if (ticks >= maxTicks) stop();
    };
    const handle = timers.setInterval(tick, intervalMs);
    const stop = () => timers.clearInterval(handle);
    tick();
    return stop;
}

/** `watchIdentity` on Steam's progress cache map. */
export function watchProgressCache(onChange: () => void, opts?: WatchOptions): () => void {
    return watchIdentity(progressCacheMap, onChange, opts);
}
