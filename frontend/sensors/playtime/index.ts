// Playtime sensor (2026-11-12): what Steam itself knows about how long each non-Steam game was played, and the shortcuts'
// names. Steam counts a shortcut's playtime when it launched it (details.nPlaytimeForever, overview.minutes_playtime_forever);
// app/playtime seeds a game it has no entry for from this, so turning tracking on never shows less than Steam did. The
// names map the steam-non-steam-playtimes plugin's sessions (keyed by game name) to appids. Reads only.
import { toUnsigned, isShortcutAppId } from "../../kernel/appid";

export interface SteamPlaytime {
    appid: number;
    name: string;
    minutes: number;
    lastPlayed: number;
}

/** A finite number or 0. */
function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** Every shortcut in the library, with Steam's own count (the larger of its app details and its overview). */
export function steamShortcutPlaytimes(): SteamPlaytime[] {
    const out: SteamPlaytime[] = [];
    try {
        const apps = ((globalThis as any).appStore?.allApps ?? []) as any[];
        const details = (globalThis as any).appDetailsStore?.m_mapAppData;
        for (const a of apps) {
            const appid = toUnsigned(a?.appid);
            if (appid === undefined || !isShortcutAppId(appid)) continue;
            const d = typeof details?.get === "function" ? details.get(appid)?.details : undefined;
            const minutes = Math.max(num(d?.nPlaytimeForever), num(a?.minutes_playtime_forever));
            const lastPlayed = Math.max(num(d?.rtLastTimePlayed), num(a?.rt_last_time_played));
            out.push({ appid, name: String(a?.display_name ?? ""), minutes, lastPlayed });
        }
    } catch {
        /* nothing to read yet */
    }
    return out;
}
