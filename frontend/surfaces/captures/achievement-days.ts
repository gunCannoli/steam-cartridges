// Surface `captures`, pure part: a shortcut's unlocks as days of Steam's activity feed (ADR-0056). The caller gives the day a
// time falls on (activity.ts: local midnight, as for the captures). Every source that stores an
// unlock time is shown: Steam emulator saves, trophy files, RetroAchievements, Epic, Xbox.
// Its imports carry `.ts`, so Node can run the unit tests with type stripping.
import type { AchievementSet } from "../../kernel/record";

/** One unlock as the activity event shows it (Steam's own achievement event fields come from these). */
export interface ActivityAchievement {
    id: string;
    name: string;
    description: string;
    icon: string;
    /** Percent of players who have it (0 when the source does not say). */
    globalPct: number;
    /** Unix seconds. */
    unlockedAt: number;
}

/** The unlocks of one day: Steam shows them as one "achieved" event. */
export interface ActivityAchievementDay {
    /** `dayOf(unlockedAt)` of every item. */
    day: number;
    /** The newest and oldest unlock time of the day (the event's time and its comment thread key). */
    latest: number;
    oldest: number;
    /** Newest first. */
    items: ActivityAchievement[];
}

/**
 * The unlocks of a set, grouped by `dayOf(unlockedAt)`, newest day first and newest unlock first within a day. An
 * unlock with no time (0 or missing) or whose id is not in the schema is left out: there is nothing true to show.
 */
export function achievementDays(set: AchievementSet | undefined, dayOf: (unixSeconds: number) => number): ActivityAchievementDay[] {
    if (!set?.schema || !set.unlocks) return [];
    const byId = new Map<string, AchievementSet["schema"]["achievements"][number]>();
    for (const a of Array.isArray(set.schema.achievements) ? set.schema.achievements : []) byId.set(String(a.id), a);

    const days = new Map<number, ActivityAchievementDay>();
    for (const [id, unlock] of Object.entries(set.unlocks)) {
        const raw = Number(unlock?.unlocked_time);
        const at = Number.isFinite(raw) ? Math.floor(raw) : 0;
        const a = byId.get(String(id));
        if (at <= 0 || !a) continue;
        const day = dayOf(at);
        let entry = days.get(day);
        if (!entry) {
            entry = { day, latest: at, oldest: at, items: [] };
            days.set(day, entry);
        }
        entry.latest = Math.max(entry.latest, at);
        entry.oldest = Math.min(entry.oldest, at);
        entry.items.push({
            id: String(a.id),
            name: a.name ?? "",
            description: a.description ?? "",
            icon: a.icon ?? "",
            globalPct: Number(a.global_pct) || 0,
            unlockedAt: at,
        });
    }
    const out = [...days.values()];
    for (const d of out) d.items.sort((x, y) => y.unlockedAt - x.unlockedAt || x.id.localeCompare(y.id));
    return out.sort((a, b) => b.day - a.day);
}
