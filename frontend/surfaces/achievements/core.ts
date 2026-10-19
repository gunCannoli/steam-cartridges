import { asList } from "../../kernel/lists.ts";
import type { AchievementSchemaRecord, AchievementSchemaItem, AchievementUnlockRecord } from "../../kernel/record";
import type { SteamAchievementItem, SteamAppAchievements, AchievementProgress } from "../../steam/achievement-types";

/**
 * Transforms backend schema and unlocks into Steam's native AppDetailsStore format.
 */
export function buildSteamAchievements(
    schema: AchievementSchemaRecord | undefined,
    unlocks: Record<string, AchievementUnlockRecord> = {},
): SteamAppAchievements | null {
    // asList: an empty list crosses the backend as `{}` (K1), which is not iterable.
    const items = schema ? asList<AchievementSchemaItem>(schema.achievements) : [];
    if (!schema || items.length === 0) {
        return null;
    }

    const achieved: SteamAchievementItem[] = [];
    const unachieved: SteamAchievementItem[] = [];

    for (const item of items) {
        const unlock = unlocks[item.id];
        const isUnlocked = !!unlock;
        const entry: SteamAchievementItem = {
            strID: item.id,
            strName: item.name,
            strDescription: item.description,
            strImage: item.icon,
            bAchieved: isUnlocked,
            rtUnlocked: unlock?.unlocked_time ?? 0,
            flAchieved: item.global_pct,
        };

        if (isUnlocked) {
            achieved.push(entry);
        } else {
            unachieved.push(entry);
        }
    }

    // Achieved sorted by most recently unlocked first
    achieved.sort((a, b) => b.rtUnlocked - a.rtUnlocked);

    // Unachieved sorted by global popularity descending (most common first)
    unachieved.sort((a, b) => (b.flAchieved ?? 0) - (a.flAchieved ?? 0));

    // Highlights: up to 5 most recently achieved, or empty array if none unlocked
    const vecHighlight = achieved.slice(0, 5);

    return {
        nTotal: schema.total || items.length,
        nAchieved: achieved.length,
        vecHighlight,
        vecAchieved: achieved,
        vecUnachieved: unachieved,
    };
}

/**
 * An entry of Steam's achievement progress cache (the Big Picture play bar; what other plugins read for any
 * game), in the shape Steam writes for an owned game (ADR-0045).
 */
export function buildAchievementProgress(
    achievements: SteamAppAchievements | null,
    appid: number,
    nowSeconds: number,
): AchievementProgress | null {
    if (!achievements) return null;
    const unlocked = achievements.nAchieved;
    const total = achievements.nTotal;
    return {
        appid,
        unlocked,
        total,
        percentage: total > 0 ? (unlocked / total) * 100 : 0,
        all_unlocked: total > 0 && unlocked === total,
        cache_time: nowSeconds,
        vetted: true,
    };
}

/**
 * What `appDetailsStore.GetAchievements(appid)` should do for one call (K19).
 *
 * Steam's own implementation is `t = GetAppData(e); void 0 === t.details?.achievements.vecHighlight &&
 * this.RequestAchievements(e); return t.details?.achievements`. A shortcut's `details` is null (we never
 * write it, plugins.md guardrail 8), so for a shortcut with nothing of ours the original always reaches
 * `RequestAchievements` and throws on the null. It would return `undefined` anyway, so answer that
 * ourselves. A Steam app is never ours: always the original.
 */
export function getAchievementsAction(input: {
    isShortcut: boolean;
    hasLocal: boolean;
    hasDetails: boolean;
}): "local" | "undefined" | "original" {
    if (!input.isShortcut) return "original";
    if (input.hasLocal) return "local";
    return input.hasDetails ? "original" : "undefined";
}
