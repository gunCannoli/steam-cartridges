// Surface `store-stub`: the only code that writes Steam's StoreItemCache. Steam's activity event renderers guard on
// `StoreItemCache.GetStoreItemWithLegacyVisibilityCheck`, and a shortcut has no store item, so its feed renders
// headings with empty bodies. A lightweight in-memory item (no network) lets Steam's own components render
// (ADR-0030). steam-cartridges writes the same stub for its own events; whichever plugin comes first creates it and
// the other leaves it alone. Shortcuts only: a Steam game has a genuine store item.
import { logger } from "../../logger";
import { isShortcutAppId } from "../../kernel/appid";
import { storeItemCache } from "../../steam/stores";
import { seedShortcutStoreItem } from "../../steam/query-client";
import { safety } from "./context";

let hooked = false;
let lastSeed: string | undefined;

/** Shortcuts whose stub this plugin made (the others belong to steam-cartridges). */
const ours = new Set<number>();

/**
 * StoreItemCache.prototype.BIsAppMissing answers false for shortcut appids: an unmounting hook's 404 store request
 * must never blacklist a shortcut in `m_setUnavailableApps` (guardrail 5). Chains with steam-cartridges' identical
 * hook; O(1) (guardrail 2).
 */
function ensureMissingHook(): void {
    if (hooked) return;
    const cache = storeItemCache();
    const proto = cache ? Object.getPrototypeOf(cache) : undefined;
    if (!proto || typeof proto.BIsAppMissing !== "function") return;
    hooked = true;
    const original = proto.BIsAppMissing;
    proto.BIsAppMissing = function (appid: number) {
        if (safety.isEnabled("store-stub")) {
            try {
                if (typeof appid === "number" && isShortcutAppId(appid)) return false;
            } catch (err) {
                safety.reportError("store-stub", err);
            }
        }
        return original.apply(this, arguments);
    };
    logger.info("Installed StoreItemCache.BIsAppMissing shortcut immunity hook.");
}

function iconUrl(appid: number, overview: any): string {
    if (overview?.icon_data) {
        const fmt = overview.icon_data_format || "png";
        return String(overview.icon_data).startsWith("data:") ? overview.icon_data : `data:image/${fmt};base64,${overview.icon_data}`;
    }
    const apps = (window as any).SteamClient?.Apps;
    if (typeof apps?.RequestIconDataForApp === "function") apps.RequestIconDataForApp(appid);
    return "";
}

/**
 * Make sure a shortcut has a visible store item, and is not on Steam's negative cache. The stub stays for the whole
 * session, even when the feed is cleared: deleting it lets an unmounting hook's 404 blacklist the appid (guardrail 5).
 */
export function ensureShortcutStoreItem(appid: number): void {
    if (!isShortcutAppId(appid) || !safety.isEnabled("store-stub")) return;
    try {
        // Steam 1794424036 (stable 2026-11): the event card reads the store item from React Query, not StoreItemCache, and
        // draws nothing unless it is visible. Seed it there first (the legacy stub below stays for older builds).
        const seedName = String((window as any).appStore?.GetAppOverviewByAppID?.(appid)?.display_name ?? "");
        const seeded = seedShortcutStoreItem(appid, seedName);
        if (seeded !== lastSeed) {
            lastSeed = seeded;
            if (seeded === "ok") logger.info("Shortcut store items seeded in Steam's query cache.");
            else logger.warn("Steam's query client not found: capture cards on shortcuts may render as empty days.");
        }
        const cache = storeItemCache();
        if (!cache) return;
        cache.m_setUnavailableApps?.delete(appid);
        ensureMissingHook();
        const existing = cache.m_mapApps.get(appid);
        if (existing && !ours.has(appid)) return; // steam-cartridges made it: its own

        const overview = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
        const name = String(overview?.display_name ?? "");
        const icon = iconUrl(appid, overview);
        if (existing) {
            // Ours from an earlier visit: the icon is often only loaded by now (RequestIconDataForApp).
            existing.GetName = () => name;
            existing.GetAssets = () => ({ GetCommunityIconURL: () => icon });
            return;
        }
        const sample = cache.m_mapApps.values().next().value;
        const stub = Object.create(sample ? Object.getPrototypeOf(sample) : Object.prototype);
        stub.m_unID = stub.m_unAppID = appid;
        stub.m_bVisible = true;
        stub.m_strName = name;
        stub.m_eItemType = 0;
        stub.m_eAppType = 1;
        stub.m_rgStoreTags = [];
        stub.m_rgStoreTagIDs = [];
        stub.m_DataRequested = { include_assets: true, include_platforms: true, include_release: true, include_tag_count: 0 };
        stub.BIsVisible = () => true;
        stub.BIsApplicationOrTool = () => false;
        stub.BContainDataRequest = () => true;
        stub.GetName = () => name;
        stub.GetAssets = () => ({ GetCommunityIconURL: () => icon });
        cache.m_mapApps.set(appid, stub);
        ours.add(appid);
    } catch (err) {
        safety.reportError("store-stub", err);
    }
}
