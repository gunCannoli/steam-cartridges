// Surface `achievements` (migration plan M3.5, ADR-0039): Steam's achievement stores
// (AppDetailsStore.GetAchievements, AchievementsFullStore, the progress cache) for shortcuts.
// Record-driven since M6b: render() feeds the stores from `record.achievements` (plan § 7.0 D4).
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import {
    deps,
    ensureAchievementsStoreHooked,
    getLocalAchievements,
    getLocalSchema,
    getLocalUnlocks,
    updateShortcutState,
} from "./store";

export { ensureAchievementsStoreHooked, getLocalAchievements, getLocalSchema, getLocalUnlocks };

export function createAchievementsSurface(d: SurfaceDeps): Surface {
    deps.isEnabled = d.isEnabled;
    deps.reportError = d.reportError;
    return {
        id: "achievements",
        touches: [
            "AppDetailsStore.GetAchievements",
            "AchievementsFullStore.LoadMyAchievements",
            "AchievementsFullStore.GetMyAchievements",
            "AchievementsFullStore.GetGlobalAchievements",
            "AchievementsFullStore.GetPlayerAchievements",
            "AchievementsFullStore.LoadFriendAchievements",
            "AchievementsFullStore.m_mapMyAchievements",
            "AchievementsFullStore.m_mapGlobalAchievements",
            "appAchievementProgressCache.m_achievementProgress",
            "AppDetailsStore.AppDetailsChanged(achievements)",
            "AppDetailsStore.appData.details.achievements",
        ],
        reads: ["achievements"],
        install() {
            // Steam may not have created the stores yet: retry for a few seconds (moved from index.tsx, M10).
            if (ensureAchievementsStoreHooked()) return;
            let attempts = 0;
            const interval = setInterval(() => {
                attempts++;
                if (ensureAchievementsStoreHooked() || attempts >= 10) clearInterval(interval);
            }, 500);
        },
        render(appid, record) {
            const part = record?.achievements;
            if (part?.status !== "ok" || !part.data) return;
            ensureAchievementsStoreHooked();
            updateShortcutState(
                appid,
                record?.identity?.data?.native?.appid ?? part.data.schema.native_appid ?? 0,
                part.data.schema,
                part.data.unlocks,
            );
        },
        clear() {},
        uninstall() {
            /* the hooks stay until Steam restarts, as before M3.5 */
        },
    };
}
