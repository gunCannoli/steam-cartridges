import type { ArtworkUrls, GameCategories, GameMetadata } from '../kernel/record';

/**
 * Pure mapping from Steam's own StoreItemCache to our metadata shape (migration
 * plan M5b; moved from features/steam-store/store-item.ts, D12: kernel types).
 * First rung of the ADR-0009 ladder; the backend `appdetails` call is the fallback.
 */

// Same mapping as backend/steam_store_appdetails.lua CATEGORY_FLAGS.
const CATEGORY_FLAGS: Record<number, keyof GameCategories> = {
    2: 'single_player',
    1: 'multiplayer',
    36: 'multiplayer',
    49: 'multiplayer',
    9: 'coop',
    38: 'coop',
    24: 'split_screen',
    37: 'split_screen',
    39: 'split_screen',
    28: 'full_controller',
    18: 'partial_controller',
    44: 'remote_play_together',
};

/** Category ids from `m_StoreCategories`, whatever shape holds them (arrays of ids or of {categoryid}). */
export function categoryIds(raw: unknown): number[] {
    const out: number[] = [];
    const visit = (v: unknown, depth: number) => {
        if (depth > 3 || v == null) return;
        if (typeof v === 'number') out.push(v);
        else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
        else if (typeof v === 'object') {
            const o = v as Record<string, unknown>;
            if (typeof o.categoryid === 'number') out.push(o.categoryid);
            else Object.values(o).forEach((x) => visit(x, depth + 1));
        }
    };
    visit(raw, 0);
    return out;
}

/**
 * The ids of Steam's `supported_player_categoryids` and `controller_categoryids`
 * groups (accessor first, raw field second). The `feature_categoryids` group
 * (Steam services) is never read (parity plan F, ADR-0038). Undefined when the
 * item carries no category data at all (the flags decide then).
 */
export function gameCategoryIds(item: any): number[] | undefined {
    if (!item?.m_StoreCategories && typeof item?.GetStoreCategories_SupportedPlayers !== 'function') return undefined;
    const group = (method: string, field: string): number[] => {
        try {
            const v = item?.[method]?.();
            if (Array.isArray(v)) return categoryIds(v);
        } catch {
            /* fall through to the raw field */
        }
        return categoryIds(item?.m_StoreCategories?.[field]);
    };
    return [
        ...group('GetStoreCategories_SupportedPlayers', 'supported_player_categoryids'),
        ...group('GetStoreCategories_Controller', 'controller_categoryids'),
    ];
}

/** Pure: a StoreItemCache item -> GameMetadata (explicit flags; achievements always false). */
export function metadataFromStoreItem(item: any, steamAppid: number, shortcutAppid: number): GameMetadata | null {
    const title = item?.m_strName;
    if (!title) return null;
    const categories: GameCategories = {
        single_player: false,
        multiplayer: false,
        coop: false,
        split_screen: false,
        full_controller: false,
        partial_controller: false,
        achievements: false,
        remote_play_together: false,
    };
    for (const id of categoryIds(item.m_StoreCategories)) {
        const flag = CATEGORY_FLAGS[id];
        if (flag) categories[flag] = true;
    }
    const basic = item.m_BasicInfo ?? {};
    const names = (v: unknown): string[] =>
        (Array.isArray(v) ? v : []).map((x: any) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
    // Steam's own accessors first (they return every credit), the raw fields second.
    const credit = (method: string, raw: unknown): string[] => {
        try {
            const v = item[method]?.();
            if (Array.isArray(v)) return names(v);
        } catch {
            /* fall through to the raw field */
        }
        return names(raw);
    };
    const description = String(basic.short_description ?? '');
    const release = Number(item.m_ReleaseInfo?.steam_release_date) || 0;
    const original = Number(item.m_ReleaseInfo?.original_steam_release_date) || 0;
    return {
        appid: shortcutAppid,
        title,
        description,
        short_description: description,
        developers: credit('GetDeveloperNames', basic.developers),
        publishers: credit('GetPublisherNames', basic.publishers),
        franchises: credit('GetFranchiseNames', basic.franchises),
        release_date: release || original,
        original_release_date: original || release,
        categories,
        store_category_ids: gameCategoryIds(item),
        source: 'steam-store',
        steam_appid: steamAppid,
    };
}

/** Hashed asset URLs from `GetAssets()`; the logo has no equivalent, so it falls back to the CDN path. */
export function assetUrlsFromItem(item: any): ArtworkUrls {
    const out: ArtworkUrls = {};
    try {
        const assets = item?.GetAssets?.();
        if (!assets) return out;
        const call = (name: string): string | undefined => {
            try {
                const v = assets[name]?.();
                return typeof v === 'string' && v ? v : undefined;
            } catch {
                return undefined;
            }
        };
        out.portrait = call('GetLibraryCapsuleURL_2x') ?? call('GetLibraryCapsuleURL');
        out.hero = call('GetLibraryHeroURL');
        out.wide = call('GetHeaderURL');
        // The 184 px community icon; Steam's own sidebar uses the 32 px GetCommunityIconURL (icon plan).
        out.icon = call('GetCommunityIconURL_Full');
        out.iconSmall = call('GetCommunityIconURL');
    } catch {
        /* fall back to CDN paths */
    }
    return out;
}
