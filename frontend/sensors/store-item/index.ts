/**
 * Queues Steam's own StoreItemCache request for a native app and polls until it
 * loads (migration plan M5b; moved from features/steam-store/store-item.ts). A
 * read of Steam's data, so a sensor (plan § 4 layer rules).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The item fields this plugin reads. BHasApp(id, request) is true only once all of them are loaded. */
const STORE_ITEM_REQUEST = {
    include_assets: true,
    include_basic_info: true,
    include_release: true,
    include_full_description: true,
};

/** Queue the request and poll (Steam loads it asynchronously; ~4 s observed). */
export async function loadStoreItem(steamAppid: number, timeoutMs = 8000): Promise<any | null> {
    const cache = (window as any).StoreItemCache;
    if (!cache?.QueueAppRequest) return null;
    try {
        // Steam already failed to load it (delisted or unknown): go straight to the fallback (P4 H4).
        if (cache.BIsAppMissing?.(steamAppid)) return null;
        if (!cache.BHasApp?.(steamAppid, STORE_ITEM_REQUEST)) {
            cache.QueueAppRequest(steamAppid, STORE_ITEM_REQUEST);
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (cache.BHasApp?.(steamAppid, STORE_ITEM_REQUEST)) {
                const item = cache.GetApp?.(steamAppid);
                if (item?.m_strName) return item;
            }
            await sleep(500);
        }
    } catch {
        /* fall through to the backend fallback */
    }
    return null;
}
