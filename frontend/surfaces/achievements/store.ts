// Surface `achievements` (migration plan M3.5, ADR-0039): the only code that feeds Steam's
// achievement stores for shortcuts. Moved from features/achievements/store.ts.
import { logger } from "../../logger";
import { isShortcutAppId, toUnsigned } from "../../kernel/appid";
import type { AchievementSchemaRecord, AchievementUnlockRecord } from "../../kernel/record";
import type { SurfaceDeps } from "../../kernel/surface";
import type { SteamAppAchievements } from "../../steam/achievement-types";
import { buildAchievementProgress, buildSteamAchievements, getAchievementsAction } from "./core";
import { resolveSingleton } from "../../steam/modules";

/** Set by createAchievementsSurface (plan § 7.0 D6); open defaults until then. */
export const deps: SurfaceDeps = { isEnabled: () => true, reportError: () => {} };

/**
 * Fail-open (plan § 7.0 D6): wrap an installed hook so a switched-off surface, a throw or a
 * rejected promise falls back to Steam's original method.
 */
function failOpen(target: any, name: string, original: (...args: any[]) => any): void {
    const hook = target[name];
    target[name] = function (this: any, ...args: any[]) {
        if (!deps.isEnabled("achievements")) return original.apply(this, args);
        try {
            const result = hook.apply(this, args);
            if (result && typeof result.then === "function") {
                return result.catch((err: unknown) => {
                    deps.reportError("achievements", err);
                    return original.apply(this, args);
                });
            }
            return result;
        } catch (err) {
            deps.reportError("achievements", err);
            return original.apply(this, args);
        }
    };
}

const achievementsMap = new Map<number, SteamAppAchievements>();
const schemasMap = new Map<number, AchievementSchemaRecord>();
const unlocksMap = new Map<number, Record<string, AchievementUnlockRecord>>();

let storeHooked = false;
let fullStoreHooked = false;

interface AchievementsFullStore {
    m_mapMyAchievements: Map<number, any>;
    m_mapGlobalAchievements: Map<number, any>;
    m_mapPlayerAchievements: Map<string, any>;
    m_mapInflightMyAchievementsRequests?: Map<number, boolean>;
    m_mapInflightAchievementsRequests?: Map<string, boolean>;
    GetMyAchievements: (appid: number) => any;
    GetGlobalAchievements: (appid: number) => any;
    GetPlayerAchievements: (appid: number, accountid: any) => any;
    LoadMyAchievements: (appid: number) => Promise<void>;
    LoadFriendAchievements?: (appid: number, accountid: any) => Promise<void>;
}

let cachedFullStore: AchievementsFullStore | undefined;

function resolveAchievementsFullStore(): AchievementsFullStore | undefined {
    if (cachedFullStore) return cachedFullStore;
    cachedFullStore = resolveSingleton<AchievementsFullStore>("AchievementsFullStore", [
        "GetMyAchievements",
        "GetGlobalAchievements",
        "LoadMyAchievements",
    ]);
    return cachedFullStore;
}

/**
 * Feeds Steam's full achievements singleton store (module 32179 / p6)
 * so that full-page views (Big Picture Mode and desktop individual views)
 * render native achievements instead of "Failed to load achievement data".
 */
export function feedAchievementsFullStore(
    shortcutAppId: number,
    achievements: SteamAppAchievements,
): void {
    const store = resolveAchievementsFullStore();
    if (!store) return;

    const achieved: Record<string, any> = {};
    const unachieved: Record<string, any> = {};
    const globalPcts: Record<string, number> = {};

    for (const a of achievements.vecAchieved) {
        achieved[a.strID] = {
            strID: a.strID,
            strName: a.strName,
            strDescription: a.strDescription,
            strImage: a.strImage,
            bAchieved: true,
            bHidden: false,
            rtUnlocked: a.rtUnlocked,
            flAchieved: a.flAchieved ?? 0,
            flCurrentProgress: 0,
        };
        globalPcts[a.strID] = a.flAchieved ?? 0;
    }

    for (const a of achievements.vecUnachieved) {
        unachieved[a.strID] = {
            strID: a.strID,
            strName: a.strName,
            strDescription: a.strDescription,
            strImage: a.strImage,
            bAchieved: false,
            bHidden: false,
            rtUnlocked: 0,
            flAchieved: a.flAchieved ?? 0,
            flCurrentProgress: 0,
        };
        globalPcts[a.strID] = a.flAchieved ?? 0;
    }

    store.m_mapMyAchievements.set(shortcutAppId, {
        data: {
            achieved,
            unachieved,
            hidden: {},
        },
    });

    store.m_mapGlobalAchievements.set(shortcutAppId, {
        data: globalPcts,
    });
}

/**
 * Monkey-patches AchievementsFullStore methods so that full-screen views
 * never send failing GetMyAchievementsForApp requests to Steam for shortcuts.
 */
export function ensureAchievementsFullStoreHooked(): boolean {
    if (fullStoreHooked) return true;

    const store = resolveAchievementsFullStore();
    if (!store) return false;

    const proto = Object.getPrototypeOf(store);
    if (!proto) return false;

    const origLoadMy = proto.LoadMyAchievements;
    if (typeof origLoadMy === "function") {
        proto.LoadMyAchievements = async function (appId: number) {
            const rawId = appId >>> 0;
            if (isShortcutAppId(rawId)) {
                const local = achievementsMap.get(rawId) || achievementsMap.get(appId);
                if (local) {
                    feedAchievementsFullStore(rawId, local);
                    this.m_mapInflightMyAchievementsRequests?.delete(appId);
                    this.m_mapInflightMyAchievementsRequests?.delete(rawId);
                    return;
                }
            }
            return origLoadMy.call(this, appId);
        };
    }

    const origGetMy = proto.GetMyAchievements;
    if (typeof origGetMy === "function") {
        proto.GetMyAchievements = function (appId: number) {
            const rawId = appId >>> 0;
            if (isShortcutAppId(rawId)) {
                const local = achievementsMap.get(rawId) || achievementsMap.get(appId);
                if (local && !this.m_mapMyAchievements.has(rawId) && !this.m_mapMyAchievements.has(appId)) {
                    feedAchievementsFullStore(rawId, local);
                }
            }
            return origGetMy.call(this, appId);
        };
    }

    const origGetGlobal = proto.GetGlobalAchievements;
    if (typeof origGetGlobal === "function") {
        proto.GetGlobalAchievements = function (appId: number) {
            const rawId = appId >>> 0;
            if (isShortcutAppId(rawId)) {
                const local = achievementsMap.get(rawId) || achievementsMap.get(appId);
                if (local && !this.m_mapGlobalAchievements.has(rawId) && !this.m_mapGlobalAchievements.has(appId)) {
                    feedAchievementsFullStore(rawId, local);
                }
            }
            return origGetGlobal.call(this, appId);
        };
    }

    const origGetPlayer = proto.GetPlayerAchievements;
    if (typeof origGetPlayer === "function") {
        proto.GetPlayerAchievements = function (appId: number, accountId: any) {
            const rawId = appId >>> 0;
            if (isShortcutAppId(rawId)) {
                const local = achievementsMap.get(rawId) || achievementsMap.get(appId);
                if (local) {
                    const achieved: Record<string, any> = {};
                    const unachieved: Record<string, any> = {};
                    for (const a of local.vecAchieved) achieved[a.strID] = a;
                    for (const a of local.vecUnachieved) unachieved[a.strID] = a;
                    return { data: { achieved, unachieved } };
                }
            }
            return origGetPlayer.call(this, appId, accountId);
        };
    }

    const origLoadFriend = proto.LoadFriendAchievements;
    if (typeof origLoadFriend === "function") {
        proto.LoadFriendAchievements = async function (appId: number, accountId: any) {
            const rawId = appId >>> 0;
            if (isShortcutAppId(rawId)) {
                const key1 = `${appId}_${accountId}`;
                const key2 = `${rawId}_${accountId}`;
                this.m_mapInflightAchievementsRequests?.delete(key1);
                this.m_mapInflightAchievementsRequests?.delete(key2);
                return;
            }
            return origLoadFriend.call(this, appId, accountId);
        };
    }

    if (typeof origLoadMy === "function") failOpen(proto, "LoadMyAchievements", origLoadMy);
    if (typeof origGetMy === "function") failOpen(proto, "GetMyAchievements", origGetMy);
    if (typeof origGetGlobal === "function") failOpen(proto, "GetGlobalAchievements", origGetGlobal);
    if (typeof origGetPlayer === "function") failOpen(proto, "GetPlayerAchievements", origGetPlayer);
    if (typeof origLoadFriend === "function") failOpen(proto, "LoadFriendAchievements", origLoadFriend);

    fullStoreHooked = true;
    logger.info("Successfully hooked AchievementsFullStore for non-Steam individual achievements page.");
    return true;
}

/**
 * Monkey-patches AppDetailsStore.GetAchievements to serve mirrored non-Steam achievements.
 */
export function ensureAchievementsStoreHooked(): boolean {
    ensureAchievementsFullStoreHooked();

    if (storeHooked) return true;

    const store = (window as any).appDetailsStore;
    if (!store || typeof store.GetAchievements !== "function") {
        return false;
    }

    const origGetAchievements = store.GetAchievements.bind(store);
    store.GetAchievements = function (appId: number) {
        const rawId = appId >>> 0;
        const shortcut = isShortcutAppId(rawId);
        const local = shortcut ? achievementsMap.get(rawId) || achievementsMap.get(appId) : undefined;
        // K19: Steam's original throws for a shortcut with null `details`; see getAchievementsAction.
        const action = getAchievementsAction({
            isShortcut: shortcut,
            hasLocal: !!local,
            hasDetails: !!store.GetAppData?.(appId)?.details,
        });
        if (action === "local") return local;
        if (action === "undefined") return undefined;
        return origGetAchievements(appId);
    };

    failOpen(store, "GetAchievements", origGetAchievements);

    storeHooked = true;
    logger.info("Successfully hooked appDetailsStore.GetAchievements for non-Steam games.");
    return true;
}

/**
 * Updates achievements state for a shortcut and synchronizes with Steam's internal caches.
 */
export function setShortcutAchievements(
    shortcutAppId: number,
    achievements: SteamAppAchievements,
): void {
    const rawId = shortcutAppId >>> 0;
    const signedId = shortcutAppId | 0;
    achievementsMap.set(rawId, achievements);

    // Synchronize full individual achievements store (Big Picture and desktop)
    try {
        feedAchievementsFullStore(rawId, achievements);
    } catch (e) {
        logger.warn("Could not feed AchievementsFullStore:", e);
    }

    // Steam's progress cache (Big Picture play bar; what other plugins read for any game), one entry in Steam's
    // own shape per key. cache_time = now: Steam's GetAchievementProgress asks its server again for an entry
    // older than the game's rt_last_time_played (ADR-0045).
    try {
        const cache = (window as any).appAchievementProgressCache?.m_achievementProgress?.mapCache;
        if (cache && typeof cache.set === "function") {
            const now = Math.floor(Date.now() / 1000);
            const unsignedEntry = buildAchievementProgress(achievements, rawId, now);
            const signedEntry = buildAchievementProgress(achievements, signedId, now);
            if (unsignedEntry && signedEntry) {
                cache.set(rawId, unsignedEntry);
                cache.set(signedId, signedEntry);
            }
        }
    } catch (e) {
        logger.warn("Could not update Big Picture achievement progress cache:", e);
    }

    // Synchronize appDetailsStore appData.details.achievements for MobX reactivity, only where Steam
    // created `details` itself: guardrail 8 (never create or overwrite appData.details; M10 fix).
    // m_mapAppData.get, not GetAppData: GetAppData creates an entry for an id it does not know (verified live
    // 2026-09-30), and the start-up preload renders every shortcut with stored achievements (ADR-0045).
    try {
        const appDataMap = (window as any).appDetailsStore?.m_mapAppData;
        if (appDataMap && typeof appDataMap.get === "function") {
            for (const id of [rawId, signedId, shortcutAppId]) {
                const appData = appDataMap.get(id);
                if (appData?.details) appData.details.achievements = achievements;
            }
        }
    } catch (e) {
        logger.warn("Could not update appDetailsStore appData:", e);
    }

    // Trigger re-render of desktop right-column section and other observers
    try {
        (window as any).appDetailsStore?.AppDetailsChanged?.(rawId);
        (window as any).appDetailsStore?.AppDetailsChanged?.(signedId);
    } catch (e) {
        logger.warn("Failed to notify appDetailsStore of achievement change:", e);
    }

}

/**
 * Updates full state from backend schema & unlocks.
 */
export function updateShortcutState(
    shortcutAppId: number,
    nativeAppId: number,
    schema: AchievementSchemaRecord | undefined,
    unlocks: Record<string, AchievementUnlockRecord> = {},
): SteamAppAchievements | null {
    const rawId = shortcutAppId >>> 0;
    if (schema) {
        if (nativeAppId > 0) {
            schemasMap.set(nativeAppId, schema);
        }
        schemasMap.set(rawId, schema);
    }
    unlocksMap.set(rawId, unlocks);

    const built = buildSteamAchievements(schema, unlocks);
    if (built) {
        setShortcutAchievements(rawId, built);
    }
    return built;
}

/** Our three maps hold one key per app: the unsigned appid (kernel/appid.ts, M10). */
const key = (appid: unknown): number => toUnsigned(appid) ?? -1;

export function getLocalAchievements(shortcutAppId: number): SteamAppAchievements | undefined {
    return achievementsMap.get(key(shortcutAppId));
}

export function getLocalSchema(nativeAppId: number): AchievementSchemaRecord | undefined {
    return schemasMap.get(key(nativeAppId));
}

export function getLocalUnlocks(shortcutAppId: number): Record<string, AchievementUnlockRecord> | undefined {
    return unlocksMap.get(key(shortcutAppId));
}
