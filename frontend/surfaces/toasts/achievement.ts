// Surface `toasts` (migration plan M3.6): Steam's native achievement toast through
// NotificationStore.OnNotification. Moved from features/achievements/dispatcher.ts.
import { logger } from "../../logger";
import { steamRequire } from "../../steam/modules";
import { deps } from "./deps";

interface AchievementProtoResolution {
    ProtoClass: any;
    typeId: number;
}

let cachedProto: AchievementProtoResolution | undefined;

/**
 * Resolves the protobuf class for CClientNotificationAchievement and notification type ID (5).
 * Matches by signature, never by minified name or module id (ADR-0005): the module source mentions
 * `achievement_id` and `global_achieved_pct`, and an *instance* of the class has the setters
 * `set_achievement_id` and `set_global_achieved_pct` and `getClassName()` naming it. The setters are
 * not on `Class.prototype` on current Steam builds (K17: checking there found nothing), so the class
 * is instantiated to look. The type id is the `ok` member of the notification-type enum export.
 */
function resolveAchievementProto(): AchievementProtoResolution | undefined {
    if (cachedProto) return cachedProto;

    const req = steamRequire();
    if (!req || !req.m) return undefined;

    for (const [id, factory] of Object.entries(req.m)) {
        if (!factory) continue;
        const src = factory.toString();
        if (src.includes("achievement_id") && src.includes("global_achieved_pct")) {
            try {
                const mod = req(id) as Record<string, any>;
                if (!mod) continue;

                let ProtoClass: any;
                let typeId = 5;

                for (const key of Object.keys(mod)) {
                    const val = mod[key];
                    if (!ProtoClass && typeof val === "function" && typeof val.prototype?.getClassName === "function") {
                        try {
                            const probe = new val();
                            if (
                                typeof probe.set_achievement_id === "function" &&
                                typeof probe.set_global_achieved_pct === "function"
                            ) {
                                ProtoClass = val;
                            }
                        } catch {
                            /* not a message class we can construct: keep looking */
                        }
                    }
                    if (val && typeof val === "object" && typeof val.ok === "number") {
                        typeId = val.ok;
                    }
                }

                if (ProtoClass) {
                    cachedProto = { ProtoClass, typeId };
                    return cachedProto;
                }
            } catch (err) {
                logger.warn(`Failed evaluating achievement proto module ${id}:`, err);
            }
        }
    }

    return undefined;
}

export interface ToastAchievementPayload {
    id: string;
    name: string;
    description: string;
    icon: string;
    global_pct?: number;
    rtime_unlocked?: number;
}

/**
 * Dispatches a native Steam achievement toast popup and chime via NotificationStore.OnNotification.
 */
export function dispatchAchievementToast(
    shortcutAppId: number,
    item: ToastAchievementPayload,
): boolean {
    if (!deps.isEnabled("toasts")) return false;
    const store = (window as any).NotificationStore;
    if (!store || typeof store.OnNotification !== "function") {
        logger.warn("NotificationStore.OnNotification is unavailable.");
        return false;
    }

    const res = resolveAchievementProto();
    if (!res) {
        logger.warn("Could not resolve Steam achievement notification protobuf.");
        return false;
    }

    try {
        const { ProtoClass, typeId } = res;
        const msg = new ProtoClass();
        msg.set_achievement_id(item.id);
        msg.set_appid(shortcutAppId);
        msg.set_name(item.name);
        msg.set_description(item.description);
        msg.set_image_url(item.icon);
        msg.set_achieved(true);
        msg.set_rtime_unlocked(item.rtime_unlocked ?? Math.floor(Date.now() / 1000));
        msg.set_global_achieved_pct(item.global_pct ?? 0);

        const binary = msg.serializeBinary();
        const notifId = typeof store.m_nNextTestNotificationID === "number"
            ? store.m_nNextTestNotificationID++
            : Math.floor(Date.now() % 1000000);

        store.OnNotification(notifId, typeId, binary);
        logger.info(`Dispatched native achievement toast for shortcut ${shortcutAppId}: "${item.name}"`);
        return true;
    } catch (e) {
        logger.error("Failed to dispatch achievement toast:", e);
        return false;
    }
}
