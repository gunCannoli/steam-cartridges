// Surface `toasts` (migration plan M3.6, ADR-0039): the only code that shows Steam
// notifications. No hooks: writes into NotificationStore. Event-driven (M10): one toast per item
// of `achievements.unlocked` (app/achievements decides); index.tsx only subscribes the handler. The "Achievements
// Enabled" launch toast was removed (ADR-0066): it called ProcessNotification wrongly and never showed.
import type { Events } from "../../kernel/events";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { dispatchAchievementToast } from "./achievement";
import { deps } from "./deps";

export { dispatchAchievementToast };
export type { ToastAchievementPayload } from "./achievement";

/** One native toast per new unlock. */
export function onUnlocked({ appid, items }: Events["achievements.unlocked"]): void {
    for (const a of items) {
        dispatchAchievementToast(appid, { id: a.id, name: a.name, description: a.description, icon: a.icon, global_pct: a.global_pct, rtime_unlocked: a.unlockedAt });
    }
}

let testHook = false;

/** The documented CDP test hook: a `cartridges:trigger_fake_achievement` window event shows a toast (D8). */
export function installTestHook(): void {
    if (testHook || typeof window === "undefined") return;
    testHook = true;
    window.addEventListener("cartridges:trigger_fake_achievement", (e: Event) => {
        const detail = (e as CustomEvent)?.detail;
        const targetAppId = detail?.shortcutAppId || detail?.appid;
        const achievement = detail?.achievement || {
            id: "fake_achievement_" + Date.now(),
            name: "Retro Champion",
            description: "Unlocked an achievement via RetroAchievements emulator!",
            icon: "https://media.retroachievements.org/Badge/00001.png",
            global_pct: 100,
        };
        if (targetAppId) dispatchAchievementToast(targetAppId, achievement);
    });
}

export function createToastsSurface(d: SurfaceDeps): Surface {
    deps.isEnabled = d.isEnabled;
    deps.reportError = d.reportError;
    return {
        id: "toasts",
        touches: [
            "NotificationStore.OnNotification",
            "NotificationStore.m_nNextTestNotificationID",
        ],
        reads: ["achievements"],
        install() {},
        render() {
            /* event-driven: achievements.unlocked, subscribed in index.tsx (M10) */
        },
        clear() {},
        uninstall() {},
    };
}
