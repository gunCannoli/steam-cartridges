// Safety: boot sentinel (migration plan M0b, ADR-0039).
// A hung SharedJSContext cannot run any cleanup, so the sentinel works the other way
// round: every start marks the boot "pending"; a clean shutdown (pagehide) or 60 s of
// error-free running clears it. If a start finds the previous boot still pending, that
// boot ended badly. After two bad boots in a row, the plugin starts in safe mode.
// SharedJSContext's localStorage survives Steam restarts (the old sync manager relied on it too).

export const BOOT_KEY = "steam-cartridges.boot";
/** Bad boots in a row that switch safe mode on. */
export const UNCLEAN_LIMIT = 2;
export const HEALTHY_AFTER_MS = 60_000;

export interface BootState {
    pending: boolean;
    unclean: number;
    at: number;
}

export interface KeyValue {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function read(store: KeyValue): BootState {
    try {
        const v = JSON.parse(store.getItem(BOOT_KEY) ?? "null");
        if (v && typeof v.pending === "boolean" && typeof v.unclean === "number") return v;
    } catch {
        /* corrupt entry: treat as a first boot */
    }
    return { pending: false, unclean: 0, at: 0 };
}

function write(store: KeyValue, state: BootState): void {
    try {
        store.setItem(BOOT_KEY, JSON.stringify(state));
    } catch {
        /* storage unavailable: the sentinel is best-effort */
    }
}

/** Call once at plugin start. Returns whether to start in safe mode, and the bad-boot count. */
export function beginBoot(store: KeyValue, now = Date.now()): { safeMode: boolean; unclean: number } {
    const prev = read(store);
    const unclean = prev.pending ? prev.unclean + 1 : 0;
    write(store, { pending: true, unclean, at: now });
    return { safeMode: unclean >= UNCLEAN_LIMIT, unclean };
}

/** Call after HEALTHY_AFTER_MS with no feature errors, and on a clean shutdown. */
export function markHealthy(store: KeyValue, now = Date.now()): void {
    write(store, { pending: false, unclean: 0, at: now });
}

/** Wire the sentinel: clears on pagehide, and after the healthy delay if no errors were counted. */
export function watchBoot(
    store: KeyValue,
    errorCount: () => number,
    win: { addEventListener(type: string, fn: () => void): void; setTimeout(fn: () => void, ms: number): unknown },
): void {
    win.addEventListener("pagehide", () => markHealthy(store));
    win.setTimeout(() => {
        if (errorCount() === 0) markHealthy(store);
    }, HEALTHY_AFTER_MS);
}
