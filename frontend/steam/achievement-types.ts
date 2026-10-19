// Steam's own achievement shapes (AppDetailsStore, AchievementsFullStore, NotificationStore).
// Moved from features/achievements/types.ts in M3.5 so surfaces can use them.
/**
 * Types for Steam's native achievements system and internal stores.
 */

export interface SteamAchievementItem {
    strID: string;
    strName: string;
    strDescription: string;
    strImage: string;
    bAchieved: boolean;
    rtUnlocked: number;
    flMinProgress?: number;
    flCurrentProgress?: number;
    flMaxProgress?: number;
    flAchieved?: number; // Global unlock percentage
}

export interface SteamAppAchievements {
    nTotal: number;
    nAchieved: number;
    vecHighlight: SteamAchievementItem[];
    vecAchieved: SteamAchievementItem[];
    vecUnachieved: SteamAchievementItem[];
}

/** One entry of Steam's `appAchievementProgressCache.m_achievementProgress.mapCache`, in Steam's own shape (ADR-0045). */
export interface AchievementProgress {
    appid: number;
    unlocked: number;
    total: number;
    /** 0-100: what Steam's GetAchievementProgress(appid) returns. */
    percentage: number;
    all_unlocked: boolean;
    /** Unix seconds. Steam asks its server again for an entry older than the game's rt_last_time_played. */
    cache_time: number;
    vetted: boolean;
}

