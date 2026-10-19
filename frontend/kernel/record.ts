// Kernel: the GameRecord read model (migration plan M1, ADR-0039).
// One record per shortcut. Services fill parts; surfaces read them. get() is a plain
// Map lookup, so it is safe from Steam's hot hooks (plugins.md guardrail 2).
import type { ShortcutId } from "./appid";
import type { EventBus } from "./events";
import { asList } from "./lists.ts";

export type PartStatus = "ok" | "partial" | "unsupported" | "needs-setup" | "error" | "pending";

export interface Part<T> {
    status: PartStatus;
    data?: T;
    /** Which source produced `data` (e.g. "steam-store", "igdb", "local_db"). */
    source?: string;
    /** Unix ms when `data` was fetched from its source. */
    fetchedAt?: number;
    /** Unix ms when freshness was last checked, even if nothing changed. */
    checkedAt?: number;
    /** Shown to the user only for needs-setup / error (ADR-0014). */
    message?: string;
    /** Answered from disk (`noNetwork`) while due for a refresh: app/view asks again (ADR-0060). */
    stale?: boolean;
}

export interface Identity {
    native?: { appid: number; source: "manual" | "owned" | "search" };
    web?: { igdb?: number; ra?: number; ss?: number; romHash?: string };
}

/**
 * What an extension pushed for a shortcut (ADR-0067, backend provided_store): Epic and Xbox copies found by
 * steam-cartridges-third-party. The core keeps it as one more source; it knows no store.
 */
export interface ProvidedGame {
    /** The data's source id ("epic", "xbox", ...). */
    source: string;
    /** The source's name for the game (helps the Steam match). */
    title?: string;
    /** The reporting extension's id. */
    provider?: string;
}

/** Player and controller flags from a metadata source (moved from rpc.ts in M3.3, plan § 7.0 D12). */
export interface GameCategories {
    single_player?: boolean;
    multiplayer?: boolean;
    coop?: boolean;
    split_screen?: boolean;
    full_controller?: boolean;
    partial_controller?: boolean;
    achievements?: boolean;
    remote_play_together?: boolean;
}

/**
 * Normalized Game Info of one shortcut, as the backend stores it in library_metadata.json
 * (moved from rpc.ts `ConsolidatedMetadata` in M3.3, plan § 7.0 D12; rpc.ts keeps that name).
 */
/** Steam category ids a shortcut may carry: StoreItemCache player and controller ids with a known meaning (ADR-0038). */
export const PORTABLE_CATEGORY_IDS: readonly number[] = [
    // Players: 1 Multi-player, 2 Single-player, 9 Co-op, 20 MMO, 24 Shared/Split Screen,
    // 27 Cross-Platform Multiplayer, 36 Online PvP, 37 Shared/Split Screen PvP,
    // 38 Online Co-op, 39 Shared/Split Screen Co-op, 49 PvP
    1, 2, 9, 20, 24, 27, 36, 37, 38, 39, 49,
    // Achievements (22): written when a shortcut has real achievements from any source
    // (RetroAchievements, Epic, Xbox, achievement extensions). Not a Steam-licence service —
    // it is a property of the game itself, and category-policy.ts gates it on the record.
    22,
    // Controller: 18 Partial, 28 Full, 55/56 PlayStation 4, 57/58 PlayStation 5
    18, 28, 55, 56, 57, 58,
];

/**
 * Steam services seen on native apps that require a Steam licence (never written for a shortcut
 * by this plugin). Everything outside PORTABLE_CATEGORY_IDS is dropped anyway; this list names
 * them for the tests and gate check 14.
 */
export const STEAM_ONLY_CATEGORY_IDS: readonly number[] = [
    // 23 Steam Cloud, 29 Steam Trading Cards, 30 Steam Workshop,
    // 42/43 Remote Play on Phone/Tablet, 44 Remote Play Together, 59 Steam Input API,
    // 62 Family Sharing
    23, 29, 30, 42, 43, 44, 59, 62,
];

/** Every category id this plugin may have written; the game-info surface purges them before each write (guardrail 7). */
export const MANAGED_CATEGORY_IDS: readonly number[] = [...PORTABLE_CATEGORY_IDS, ...STEAM_ONLY_CATEGORY_IDS];

export interface GameMetadata {
    appid: number;
    title: string;
    igdb_id?: number;
    matched_title?: string;
    short_description?: string;
    summary?: string;
    description?: string;
    developers?: string[];
    publishers?: string[];
    franchises?: string[];
    release_date?: number;
    /** First release (Early Access start) when it differs from release_date; Steam Store only. */
    original_release_date?: number;
    genres?: string[];
    categories?: GameCategories;
    /** Steam's own player + controller category ids (StoreItemCache); filtered by category-policy.ts. */
    store_category_ids?: number[];
    custom_override?: boolean;
    /** Set by the Steam Store bucket. */
    source?: string;
    steam_appid?: number;
    /** The Steam categories the game-info surface writes, decided by app/metadata (domain/category-policy, M10). Frontend only. */
    badge_category_ids?: number[];
}

/** One achievement of a schema (moved from rpc.ts in M3.5, plan § 7.0 D12). */
export interface AchievementSchemaItem {
    id: string;
    name: string;
    description: string;
    icon: string;
    global_pct: number;
}

/** An app's achievement schema as the backend stores it (moved from rpc.ts in M3.5). */
export interface AchievementSchemaRecord {
    native_appid: number;
    total: number;
    achievements: AchievementSchemaItem[];
    fetched_at?: number;
}

/** When one achievement was unlocked (moved from rpc.ts in M3.5). */
export interface AchievementUnlockRecord {
    unlocked_time: number;
}

/** Artwork URLs per slot (moved from rpc.ts in M3.9, plan § 7.0 D12). */
export interface ArtworkUrls {
    portrait?: string;
    hero?: string;
    logo?: string;
    wide?: string;
    /** The library icon: not a SetCustomArtworkForApp slot, written with SetShortcutIcon (icon plan). */
    icon?: string;
    /** The 32 px community icon, tried when `icon` (184 px) fails: Steam's CDN lacks the large one for some apps
     *  (World of Tanks Blitz, 444200: 404, found 2026-10-04). */
    iconSmall?: string;
}

/** Field shapes are filled in by the service steps (M4-M7); kept open until then. */
/** A shortcut's achievements as the backend resolves them (`ach_service.lua`, M6a). */
export interface AchievementSet {
    schema: AchievementSchemaRecord;
    unlocks: Record<string, AchievementUnlockRecord>;
}
/** One card of Steam's Community Content section (features plan F2, backend media_service.lua). */
export interface MediaItem {
    /** "manual": a ScreenScraper PDF (features plan F2c), shown as a cover card and opened page by page. */
    kind: "video" | "screenshot" | "artwork" | "manual";
    /** Any other id: an extension's pushed media (ADR-0067: "epic", "xbox"), public URLs like IGDB's. */
    source: "igdb" | "screenscraper" | (string & {});
    /** A video's YouTube id. */
    youtube?: string;
    /** Public full-size and preview URLs (IGDB, Epic, Xbox). A ScreenScraper item has none: its image is fetched by `key` into the media bin. */
    url?: string;
    thumb?: string;
    /** ScreenScraper media key, e.g. "ss(wor)". */
    key?: string;
    width?: number;
    height?: number;
    title?: string;
}

/** The `media` part. The backend writes an empty list as `{}`: read `items` with kernel/lists asList. */
export interface CommunityMedia {
    items: MediaItem[];
    igdb_id?: number;
    ss_id?: number;
}
/** What the backend recorded as written for a shortcut's art (steam_store.json applied_artwork). */
export interface StoreApplied {
    /** Absent for SteamGridDB art (a shortcut with no Steam match). */
    steam_appid?: number;
    source?: string;
    slots: number[];
    /** Slots attempted but not written (retried once per session, P4 H5). */
    failed?: number[];
    /** SteamGridDB: every slot ever attempted, so a slot the user cleared is never refilled. */
    tried?: number[];
    at?: number;
}

/**
 * What the artwork surface writes for one shortcut (M5c): computed by app/artwork.ts from the
 * backend's `artwork` part and the pure art plan. `urls` holds only the slots in `write`.
 */
export interface ArtworkPlan {
    source: "steam-cdn" | "steamgriddb" | "cleared";
    steamAppid?: number;
    urls: ArtworkUrls;
    write: number[];
    clear: number[];
    /** Every slot attempted so far (SteamGridDB only), recorded with the written slots. */
    tried: number[];
    /** Slots already ours (kept), recorded again with the newly written ones. */
    kept: number[];
    /** Distinguishes two otherwise identical plans (a repeated Clear must re-render). */
    at: number;
    /** The shortcut's library icon, when it changes (icon plan). */
    icon?: IconPlan;
}

/**
 * The shortcut's library icon (not an artwork slot): `path` = point the shortcut at this file, which
 * app/artwork already stored through the backend (`previous` = the shortcuts.vdf value it replaces);
 * `restore` = put back the value ours replaced ("" = the exe). No bytes and no URL: a surface only writes.
 */
export type IconPlan = { path: string; previous: string } | { restore: string };

/**
 * The routing policy's answer for one shortcut (domain/routing, ADR-0040): which bucket, and why.
 * Passed to every app/ resolver and to the backend as context; not stored in the record (ADR-0044).
 */
export interface Route {
    bucket: "steam-store" | "web-scraping" | "none";
    via: string;
}

/** A native game Steam already knows (sensors/owned-apps), sent to the resolver as context. */
export interface OwnedCandidate {
    appid: number;
    name: string;
}

/** Progress of the background ingestion (app/ingest), shown by the settings panel. */
export interface SyncProgress {
    isSyncing: boolean;
    total: number;
    current: number;
    currentGame: string;
    phase: "idle" | "scraping" | "complete";
}

export interface GameRecord {
    appid: ShortcutId;
    gameid: string;
    title: string;
    exe: string;
    identity?: Part<Identity>;
    metadata?: Part<GameMetadata>;
    achievements?: Part<AchievementSet>;
    media?: Part<CommunityMedia>;
    artwork?: Part<ArtworkPlan>;
    /** What an extension pushed for the shortcut (ADR-0067); `unsupported` for any other shortcut. */
    provided?: Part<ProvidedGame>;
}

export type RecordPart = "identity" | "metadata" | "achievements" | "media" | "artwork" | "provided";

export interface RecordStore {
    get(appid: ShortcutId): GameRecord | undefined;
    /** Create or replace the identity fields of a record, keeping its parts. */
    upsert(base: Pick<GameRecord, "appid" | "gameid" | "title" | "exe">): GameRecord;
    /**
     * Set parts of a record. Emits `record.updated` with only the parts whose value
     * actually changed (compared by JSON), so an unchanged write re-renders nothing
     * (guardrail 17). Returns the changed part names.
     */
    update(appid: ShortcutId, parts: Partial<Pick<GameRecord, RecordPart>>): RecordPart[];
    all(): GameRecord[];
}

/**
 * K1 at the one door every part comes through: the backend's JSON writes an empty Lua list as `{}`, so a part's lists
 * (an achievement schema's `achievements`, the media `items`) are made arrays here, once, instead of at every reader
 * (found 2026-10-15: `schema.achievements.map is not a function` for a RetroAchievements game with an empty set). Pure.
 */
export function normalizePart<K extends RecordPart>(key: K, value: GameRecord[K]): GameRecord[K] {
    const part = value as Part<any> | undefined;
    const data = part?.data;
    if (!data || typeof data !== "object") return value;
    if (key === "achievements" && data.schema && typeof data.schema === "object" && !Array.isArray(data.schema.achievements)) {
        return { ...part, data: { ...data, schema: { ...data.schema, achievements: asList(data.schema.achievements) } } } as GameRecord[K];
    }
    if (key === "media" && "items" in data && !Array.isArray(data.items)) {
        return { ...part, data: { ...data, items: asList(data.items) } } as GameRecord[K];
    }
    return value;
}

export function createRecordStore(bus: EventBus): RecordStore {
    const records = new Map<ShortcutId, GameRecord>();
    return {
        get: (appid) => records.get(appid),
        upsert(base) {
            const prev = records.get(base.appid);
            const next: GameRecord = { ...(prev ?? {}), ...base };
            records.set(base.appid, next);
            return next;
        },
        update(appid, parts) {
            const rec = records.get(appid);
            if (!rec) return [];
            const changed: RecordPart[] = [];
            for (const key of Object.keys(parts) as RecordPart[]) {
                const value = normalizePart(key, parts[key]);
                if (JSON.stringify(rec[key]) === JSON.stringify(value)) continue;
                (rec as any)[key] = value;
                changed.push(key);
            }
            if (changed.length > 0) bus.emit("record.updated", { appid, parts: changed });
            return changed;
        },
        all: () => [...records.values()],
    };
}
