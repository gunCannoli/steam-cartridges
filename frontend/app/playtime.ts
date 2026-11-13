// app/playtime (2026-11-12; the steam-non-steam-playtimes plugin's job, taken over): how long each non-Steam game was
// played. Sessions come from the lifecycle sensor (launch, quit) with a checkpoint while the game runs, so a crash or a
// Steam exit loses at most CHECKPOINT_MS. The totals live in the backend's own file (playtime_store.lua: no metadata
// refresh touches it) and here per game for the play bar (surfaces/game-info shows them in Steam's own stats).
// Pure orchestration with injected dependencies; tests drive it with fakes.
import type { PlaytimeEntry } from "../kernel/record";

/** How often a running game's session is saved. */
export const CHECKPOINT_MS = 5 * 60 * 1000;

export interface PlaytimeDeps {
    /** Track Playtime is on (the setting, and the feature's kill switch). */
    enabled(): boolean;
    /** Unix seconds. */
    now(): number;
    every(ms: number, fn: () => void): () => void;
    load(): Promise<Record<string, PlaytimeEntry> | undefined>;
    record(appid: number, started: number, ended: number): Promise<PlaytimeEntry | undefined>;
    set(appid: number, minutes: number): Promise<PlaytimeEntry | undefined>;
    seed(items: { appid: number; minutes: number; last_played: number; source: string }[]): Promise<number>;
    /** Steam's own count per shortcut, and the names (sensors/playtime). */
    steamCounts(): { appid: number; name: string; minutes: number; lastPlayed: number }[];
    /** A game's total changed: the play bar re-renders. */
    changed(appid: number): void;
    log(message: string): void;
}

export interface Playtime {
    /** Load the totals and seed the games Steam has a count for that we do not (call once Steam's stores are up). */
    start(): Promise<void>;
    of(appid: number): PlaytimeEntry | undefined;
    launched(appid: number): void;
    quit(appid: number): Promise<void>;
    /** Set a game's total by hand (Properties > Cartridge). */
    setMinutes(appid: number, minutes: number): Promise<PlaytimeEntry | undefined>;
    /**
     * Seed one game we have nothing for from Steam's own count, once Steam knows it: Steam loads a shortcut's details (its
     * count) only when its page opens, so start() can miss it (2026-11-13: Metroid Fusion's page said 70 min, Properties >
     * Cartridge said 0). `steam` is the count the caller just read (the play bar); without it the sensor is asked. Resolves
     * to the game's entry, or undefined when Steam has no count either.
     */
    adopt(appid: number, steam?: { minutes: number; last_played: number }): Promise<PlaytimeEntry | undefined>;
    /**
     * Import what the steam-non-steam-playtimes plugin recorded (per game name) for the games we have nothing for. Returns
     * how many games were added; names that match no shortcut, or more than one, are left out.
     */
    importByName(games: { name: string; minutes: number; last_played: number }[]): Promise<{ added: number; unmatched: number; ambiguous: number }>;
    running(): number[];
}

export function createPlaytime(d: PlaytimeDeps): Playtime {
    const totals = new Map<number, PlaytimeEntry>();
    /** Running games: appid -> session start (unix seconds). */
    const sessions = new Map<number, number>();
    let stopCheckpoint: (() => void) | undefined;

    function put(appid: number, e: PlaytimeEntry | undefined): void {
        if (!e) return;
        totals.set(appid, e);
        d.changed(appid);
    }

    async function save(appid: number, started: number): Promise<void> {
        const ended = d.now();
        if (ended <= started) return;
        put(appid, await d.record(appid, started, ended));
    }

    function ensureCheckpoint(): void {
        if (sessions.size === 0) {
            stopCheckpoint?.();
            stopCheckpoint = undefined;
            return;
        }
        stopCheckpoint ??= d.every(CHECKPOINT_MS, () => {
            for (const [appid, started] of sessions) void save(appid, started);
        });
    }

    let loaded = false;
    const adopting = new Map<number, Promise<PlaytimeEntry | undefined>>();
    /** Seeds that did not land: not asked again this session (the play bar asks on every render; changed() re-renders). */
    const gaveUp = new Set<number>();

    async function reload(): Promise<void> {
        const all = (await d.load()) ?? {};
        loaded = true;
        totals.clear();
        for (const [k, e] of Object.entries(all)) if (e) totals.set(Number(k), e);
    }

    return {
        async start() {
            await reload();
            // Steam's own count seeds a game we do not track yet: turning tracking on never shows less than Steam did.
            const seeds = d
                .steamCounts()
                .filter((s) => s.minutes > 0 && !totals.has(s.appid))
                .map((s) => ({ appid: s.appid, minutes: s.minutes, last_played: s.lastPlayed, source: "steam" }));
            if (seeds.length) {
                const added = await d.seed(seeds);
                if (added) {
                    d.log(`playtime: seeded ${added} game(s) from Steam's own count`);
                    await reload();
                }
            }
            for (const appid of totals.keys()) d.changed(appid);
        },
        of: (appid) => (d.enabled() ? totals.get(appid) : undefined),
        launched(appid) {
            if (!d.enabled() || sessions.has(appid)) return;
            sessions.set(appid, d.now());
            ensureCheckpoint();
        },
        async quit(appid) {
            const started = sessions.get(appid);
            if (started === undefined) return;
            sessions.delete(appid);
            ensureCheckpoint();
            await save(appid, started);
        },
        async setMinutes(appid, minutes) {
            const e = await d.set(appid, Math.max(0, Math.round(minutes)));
            put(appid, e);
            return e;
        },
        adopt(appid, steam) {
            if (!d.enabled() || !loaded) return Promise.resolve(undefined);
            const have = totals.get(appid);
            if (have) return Promise.resolve(have);
            const inflight = adopting.get(appid);
            if (inflight) return inflight;
            if (gaveUp.has(appid)) return Promise.resolve(undefined);
            const fromSensor = d.steamCounts().find((s) => s.appid === appid);
            const minutes = Math.round(steam?.minutes ?? fromSensor?.minutes ?? 0);
            const last = steam?.last_played ?? fromSensor?.lastPlayed ?? 0;
            if (!(minutes > 0)) return Promise.resolve(undefined);
            const job = (async () => {
                try {
                    const added = await d.seed([{ appid, minutes, last_played: last, source: "steam" }]);
                    await reload();
                    if (added) d.log(`playtime: seeded 1 game from Steam's own count once its page loaded`);
                    const entry = totals.get(appid);
                    if (!entry) gaveUp.add(appid);
                    else d.changed(appid);
                    return entry;
                } catch (err) {
                    gaveUp.add(appid);
                    throw err;
                } finally {
                    adopting.delete(appid);
                }
            })();
            adopting.set(appid, job);
            return job;
        },
        async importByName(games) {
            await reload(); // what we already track is never replaced
            const byName = new Map<string, number[]>();
            for (const s of d.steamCounts()) {
                const k = s.name.trim().toLowerCase();
                if (!k) continue;
                byName.set(k, [...(byName.get(k) ?? []), s.appid]);
            }
            let unmatched = 0;
            let ambiguous = 0;
            const items: { appid: number; minutes: number; last_played: number; source: string }[] = [];
            for (const g of games) {
                const ids = byName.get(g.name.trim().toLowerCase()) ?? [];
                if (ids.length === 0) unmatched++;
                else if (ids.length > 1) ambiguous++;
                else if (!totals.has(ids[0]!)) items.push({ appid: ids[0]!, minutes: g.minutes, last_played: g.last_played, source: "imported" });
            }
            const added = items.length ? await d.seed(items) : 0;
            if (added) await reload();
            for (const it of items) d.changed(it.appid);
            return { added, unmatched, ambiguous };
        },
        running: () => [...sessions.keys()],
    };
}
