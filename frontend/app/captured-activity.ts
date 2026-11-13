// app/publisher: when an app's feed is (re)built. Pure orchestration with injected dependencies; tests drive it with
// fakes. Captures are Steam's own data, read live each time, so "cleaning up" is the same act as publishing: what
// Steam no longer lists (a screenshot or recording the user deleted) is simply not in the next publish.
//   - a page view reads the app's captures and publishes them (the cleanup "on the next game page visit");
//   - Steam saying a screenshot or clip was saved or deleted (sensors/captures) re-reads that app, CHANGE_DEBOUNCE_MS
//     after the last such event, if it was viewed this session: the feed follows within seconds, no polling;
//   - a game quitting re-reads it (new captures exist then);
//   - a sweep re-reads the apps viewed recently: the fallback for what no event reports (another writer replacing the
//     feed entry), every SWEEP_MS with Steam's events live (SWEEP_NO_EVENTS_MS without them).
// Unchanged captures write nothing (guardrail 17.2).
import { captureDays, createRecent, inScope, signature, type CaptureDay, type ClipLike, type Scope, type ScreenshotLike } from "../domain/captured-activity.ts";

/** How often the recently viewed apps are re-read when Steam's capture events are live (they report the changes). */
export const SWEEP_MS = 15 * 60 * 1000;
/** ...and when they are not (an older Steam without them): the only way a deletion reaches the feed then. */
export const SWEEP_NO_EVENTS_MS = 5 * 60 * 1000;
/** A screenshot burst or a clip save sends several events: one re-read this long after the last. */
export const CHANGE_DEBOUNCE_MS = 1500;
/** How many recently viewed apps the sweep keeps; the oldest one's captures leave its feed. */
export const MAX_TRACKED = 20;
/** Steam's stores can be missing for a few seconds after start-up: a publish that found none retries this often. */
export const RETRY_MS = 2000;
export const MAX_RETRIES = 5;

export interface PublisherDeps {
    scope(): Scope;
    readCaptures(appid: number): Promise<{ screenshots: ScreenshotLike[]; clips: ClipLike[] }>;
    /** Write the days into Steam's feed (an empty list clears); false when Steam's stores are not there yet. */
    publish(appid: number, days: CaptureDay[]): boolean;
    clear(appid: number): void;
    /** Another writer replaced the app's feed entry without our events. */
    needsRepair(appid: number): boolean;
    /** The app gained or lost captures in its feed (shortcut pages re-render their section list). */
    contentChanged(appid: number): void;
    dayOf(unixSeconds: number): number;
    every(ms: number, fn: () => void): () => void;
    after(ms: number, fn: () => void): void;
    log(message: string): void;
}

export interface Publisher {
    viewed(appid: number): Promise<void>;
    /** Steam reported a capture of this app saved or deleted: re-read it soon, if it was viewed this session. */
    changed(appid: number): void;
    quit(appid: number): Promise<void>;
    /** Re-read every tracked app (the timer calls it; tests and CDP may too). */
    sweep(): Promise<void>;
    /** The settings changed: apps leaving the scope lose their captures, apps entering it get them. */
    scopeChanged(): Promise<void>;
    /** Start the sweep, every `intervalMs` (SWEEP_MS by default). */
    start(intervalMs?: number): void;
    stop(): void;
    tracked(): number[];
}

export function createPublisher(d: PublisherDeps): Publisher {
    const recent = createRecent(MAX_TRACKED);
    /** The signature each app's feed shows now ("" or absent: none). */
    const shown = new Map<number, string>();
    /** The read running per app, and the one queued behind it (several asks while one runs make one more read). */
    const running = new Map<number, Promise<void>>();
    const queued = new Map<number, Promise<void>>();
    const retries = new Map<number, number>();
    let stopTimer: (() => void) | undefined;
    /** Per app, the latest change event; the re-read runs when it is still the latest after the debounce. */
    const changes = new Map<number, number>();
    let changeSeq = 0;

    function drop(appid: number): void {
        if (!shown.has(appid)) return;
        const had = (shown.get(appid) ?? "") !== "";
        shown.delete(appid);
        d.clear(appid);
        if (had) d.contentChanged(appid);
    }

    /**
     * Read and publish one app. An ask while a read of the same app runs waits for one fresh read after it (the
     * captures may have changed since that read started); every caller's promise settles once its data is in.
     */
    function refresh(appid: number): Promise<void> {
        const current = running.get(appid);
        if (current) {
            let next = queued.get(appid);
            if (!next) {
                next = current.then(() => {
                    queued.delete(appid);
                    return refresh(appid);
                });
                queued.set(appid, next);
            }
            return next;
        }
        const run = read(appid)
            .catch((err) => d.log(`Reading the captures of ${appid} failed: ${String(err)}`))
            .finally(() => running.delete(appid));
        running.set(appid, run);
        return run;
    }

    async function read(appid: number): Promise<void> {
        if (!inScope(appid, d.scope())) {
            drop(appid);
            return;
        }
        const { screenshots, clips } = await d.readCaptures(appid);
        if (!inScope(appid, d.scope())) {
            drop(appid); // switched off while reading
            return;
        }
        const days = captureDays(appid, screenshots, clips, d.dayOf);
        const sig = signature(days);
        const before = shown.get(appid);
        if (before === sig && !d.needsRepair(appid)) return;
        if (!d.publish(appid, days)) {
            const n = (retries.get(appid) ?? 0) + 1;
            retries.set(appid, n);
            if (n <= MAX_RETRIES) d.after(RETRY_MS, () => void refresh(appid));
            return;
        }
        retries.delete(appid);
        shown.set(appid, sig);
        const had = (before ?? "") !== "";
        const has = sig !== "";
        if (had !== has) d.contentChanged(appid);
        if (before !== undefined && before !== sig) {
            const count = days.reduce((n, x) => n + x.items.length, 0);
            d.log(`Captures of ${appid} changed: the feed now shows ${count} on ${days.length} day(s).`);
        }
    }

    async function sweep(): Promise<void> {
        for (const appid of recent.list()) await refresh(appid);
    }

    return {
        async viewed(appid) {
            const evicted = recent.touch(appid);
            if (evicted !== undefined) drop(evicted);
            await refresh(appid);
        },
        changed(appid) {
            if (!recent.has(appid)) return; // not viewed this session: its next view reads it
            const seq = ++changeSeq;
            changes.set(appid, seq);
            d.after(CHANGE_DEBOUNCE_MS, () => {
                if (changes.get(appid) !== seq) return;
                changes.delete(appid);
                void refresh(appid);
            });
        },
        async quit(appid) {
            if (recent.has(appid)) await refresh(appid);
        },
        sweep,
        scopeChanged: sweep,
        start(intervalMs = SWEEP_MS) {
            stopTimer ??= d.every(intervalMs, () => void sweep());
        },
        stop() {
            stopTimer?.();
            stopTimer = undefined;
        },
        tracked: () => recent.list(),
    };
}
