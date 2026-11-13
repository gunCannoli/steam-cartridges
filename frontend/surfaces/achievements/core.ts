import { asList } from "../../kernel/lists.ts";
import type { AchievementSchemaRecord, AchievementSchemaItem, AchievementUnlockRecord } from "../../kernel/record";
import type { SteamAchievementItem, SteamAppAchievements, AchievementProgress } from "../../steam/achievement-types";

/**
 * Transforms backend schema and unlocks into Steam's native AppDetailsStore format. `iconOf` turns an item's icon
 * into the one Steam shows (store.ts passes steam/achievement-icon's fallback for an item without one).
 */
export function buildSteamAchievements(
    schema: AchievementSchemaRecord | undefined,
    unlocks: Record<string, AchievementUnlockRecord> = {},
    iconOf: (icon: string | undefined) => string = (icon) => icon ?? "",
): SteamAppAchievements | null {
    // asList: an empty list crosses the backend as `{}` (K1), which is not iterable.
    const items = schema ? asList<AchievementSchemaItem>(schema.achievements) : [];
    if (!schema || items.length === 0) {
        return null;
    }

    const achieved: SteamAchievementItem[] = [];
    const unachieved: SteamAchievementItem[] = [];
    // Steam's shape for secret achievements (692850, 2026-10-19): a locked one is in no list, only in nTotal (and in
    // AchievementsFullStore's `hidden` map); an unlocked one is listed like any other, with bHidden, and in
    // vecAchievedHidden.
    const hidden: SteamAchievementItem[] = [];

    for (const item of items) {
        const unlock = unlocks[item.id];
        const isUnlocked = !!unlock;
        const entry: SteamAchievementItem = {
            strID: item.id,
            strName: item.name,
            strDescription: item.description,
            strImage: iconOf(item.icon),
            bAchieved: isUnlocked,
            rtUnlocked: unlock?.unlocked_time ?? 0,
            bHidden: item.hidden === true,
            flAchieved: item.global_pct,
        };

        if (isUnlocked) {
            achieved.push(entry);
        } else if (entry.bHidden) {
            hidden.push(entry);
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
        vecAchievedHidden: achieved.filter((a) => a.bHidden),
        vecHidden: hidden,
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

/** Steam's React Query achievement data for one app (Steam 1794424036, module 51848), raw: before the hooks' `select`. */
export interface AchievementQueries {
    schema: {
        appid: number;
        language: string;
        groups: {
            id: number;
            name?: string;
            archived: boolean;
            developeronly: boolean;
            ispublic: boolean;
            dlcappid: number;
            order: number;
            achievements: {
                internal_key: number;
                api_name: string;
                name: string;
                description: string;
                hidden: boolean;
                archived: boolean;
                icon_achieved: string | undefined;
                icon_unachieved: string | undefined;
                groupid: number;
                min_progress?: number;
                max_progress?: number;
            }[];
        }[];
        schema_hash: number;
        schema_version: number;
    };
    percentages: { percentages: Record<number, number> };
    user: {
        appid: number;
        steamid: string;
        achievements: Record<number, { internal_key: number; unlocked: boolean; unlock_time: number; progress?: number }>;
        groups: Record<number, { groupid: number; is_achievable: boolean; completed_achievements: number; is_completed: boolean; time_completed?: number }>;
        schema_hash: number;
    };
}

/** Steam's base-game achievement group id (module 76045 `o`). */
const BASE_GROUP = 0;

/**
 * Our achievements as the three queries Steam's Achievements section reads: `["achievements", appid, "schema"]`,
 * `[..., "globalpercentages"]` and `[..., "user_achievements", steamid]`. The section shows only when a group is achievable
 * (`user.groups[id].is_achievable`), so the base group is. `internal_key` is Steam's numeric id: ours are numbered in a
 * stable order (by api name), the same in all three. Locked hidden achievements are listed with `hidden` (Steam shows them
 * as secret).
 */
export function buildAchievementQueries(
    appid: number,
    steamid: string,
    a: SteamAppAchievements,
    language = "english",
): AchievementQueries {
    const seen = new Set<string>();
    const all: SteamAchievementItem[] = [];
    for (const it of [...a.vecAchieved, ...a.vecUnachieved, ...a.vecHidden]) {
        if (!it?.strID || seen.has(it.strID)) continue;
        seen.add(it.strID);
        all.push(it);
    }
    all.sort((x, y) => (x.strID < y.strID ? -1 : x.strID > y.strID ? 1 : 0));
    const percentages: Record<number, number> = {};
    const user: AchievementQueries["user"]["achievements"] = {};
    let unlocked = 0;
    let lastUnlock = 0;
    const items = all.map((it, i) => {
        const k = i + 1;
        if (typeof it.flAchieved === "number") percentages[k] = it.flAchieved;
        user[k] = { internal_key: k, unlocked: !!it.bAchieved, unlock_time: it.bAchieved ? it.rtUnlocked ?? 0 : 0 };
        if (it.bAchieved) {
            unlocked++;
            lastUnlock = Math.max(lastUnlock, it.rtUnlocked ?? 0);
        }
        return {
            internal_key: k,
            api_name: it.strID,
            name: it.strName ?? "",
            description: it.strDescription ?? "",
            hidden: !!it.bHidden,
            archived: false,
            icon_achieved: it.strImage || undefined,
            icon_unachieved: it.strImage || undefined,
            groupid: BASE_GROUP,
        };
    });
    const completed = items.length > 0 && unlocked === items.length;
    return {
        schema: {
            appid,
            language,
            groups: items.length
                ? [{ id: BASE_GROUP, archived: false, developeronly: false, ispublic: true, dlcappid: 0, order: -1, achievements: items }]
                : [],
            schema_hash: 0,
            schema_version: 0,
        },
        percentages: { percentages },
        user: {
            appid,
            steamid,
            achievements: user,
            groups: {
                [BASE_GROUP]: {
                    groupid: BASE_GROUP,
                    is_achievable: items.length > 0,
                    completed_achievements: unlocked,
                    is_completed: completed,
                    time_completed: completed ? lastUnlock || undefined : undefined,
                },
            },
            schema_hash: 0,
        },
    };
}
