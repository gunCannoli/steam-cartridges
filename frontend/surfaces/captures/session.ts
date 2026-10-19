// Surface `captures`: the Post-Game Summary session write (migration plan M6b, K14). Moved from
// features/achievements/observer-session.ts, the last Steam write outside surfaces/.
import { logger } from "../../logger";
import type { Events } from "../../kernel/events";
import { deps } from "./deps";

export interface SessionAchievement {
    id: string;
    name: string;
    description: string;
    icon: string;
    unlockedAt: number;
}

/**
 * Feed an unlock into the running game's Post-Game Summary session
 * (`appSpotlightStore.GetOrCreateAppData(appid).m_session.AddAchievement`).
 * Fail-open: a Steam that moved this API only loses the summary line, never the toast.
 */
export function addSessionAchievement(appid: number, item: SessionAchievement): void {
    if (!deps.isEnabled("captures")) return;
    try {
        const spotlight = (window as any).appSpotlightStore;
        const appData = spotlight?.GetOrCreateAppData?.(appid);
        if (appData?.m_session && typeof appData.m_session.AddAchievement === "function") {
            appData.m_session.AddAchievement(
                {
                    strID: item.id,
                    strName: item.name,
                    strDescription: item.description,
                    strImage: item.icon,
                    bAchieved: true,
                    rtUnlocked: item.unlockedAt,
                },
                Date.now(),
            );
        }
    } catch (err) {
        logger.warn("Could not push achievement to spotlight store session:", err);
    }
}

/**
 * Unlocks a store sync found after the game quit (achievements.synced, ADR-0056): the Post-Game Summary lists them like
 * any unlock; nothing toasts (the store's overlay already did).
 */
export function onSynced({ appid, items }: Events["achievements.synced"]): void {
    onUnlocked({ appid, ids: items.map((i) => i.id), items });
}

/** Each new unlock also goes into the Post-Game Summary session (achievements.unlocked, M10). */
export function onUnlocked({ appid, items }: Events["achievements.unlocked"]): void {
    for (const a of items) {
        addSessionAchievement(appid, { id: a.id, name: a.name, description: a.description, icon: a.icon, unlockedAt: a.unlockedAt });
    }
}
