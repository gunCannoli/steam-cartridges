// Setting keys, types and defaults (migration plan M8a). Type-only imports: node can load this file
// directly, which is how tests/settings-defaults.test.ts pins every default (do-not-touch 1).
import type { BucketsConfig, RoutingRule } from '../domain/routing/policy';

export interface ServicesConfig {
    steamStoreEnabled: boolean;
    screenscraperEnabled: boolean;
    igdbEnabled: boolean;
    /** SteamGridDB artwork for shortcuts with no Steam match (M5c). */
    steamgriddbEnabled: boolean;
    retroachievementsEnabled: boolean;
    emulatorsEnabled: boolean;
    rpcs3Enabled?: boolean;
}

export const DEFAULT_SERVICES: ServicesConfig = {
    steamStoreEnabled: true,
    screenscraperEnabled: true,
    igdbEnabled: true,
    steamgriddbEnabled: true,
    retroachievementsEnabled: true,
    emulatorsEnabled: true,
    rpcs3Enabled: true,
};

export type ControllerOverride = 'full' | 'partial' | 'none' | 'auto';

export interface Settings {
    buckets: BucketsConfig;
    /** Full Controller Support for a shortcut that neither Steam nor its emulator decides (ADR-0038 addendum). */
    defaultFullController: boolean;
    /** Game start notification when achievements tracking is active. */
    /** RetroAchievements Hardcore Mode (strict rules, leaderboards, standard badge icons). Default true. */
    raHardcoreMode: boolean;
    /** General routing rules engine for multi-service targeting. */
    routingRules: RoutingRule[];
    /** Automatic routing based on shortcut executable and emulator info. Default true. */
    autoRoutingMode: boolean;
    /** Service enablement toggles. */
    services: ServicesConfig;
    /** Per-game controller overrides. */
    controllerOverrides: Record<string, ControllerOverride>;
    /** Show native activity card when a non-Steam game is added to the library. Default true. */
    activityShowAddedToLibrary: boolean;
    /** Show native activity card when a non-Steam game is played for the first time. Default true. */
    activityShowFirstPlayed: boolean;
    /** Show Steam's "achieved" activity card for each day a non-Steam game's achievements were unlocked (ADR-0056). Default true. */
    activityShowAchievements: boolean;
    /** Show trailers carousel on community tab. Default true. */
    communityShowTrailers: boolean;
    /** Show digital game manuals on community tab. Default true. */
    communityShowManuals: boolean;
    /** Show artworks and fanart on community tab. Default true. */
    communityShowArtworks: boolean;
    /** Show external community destinations (Discord, Speedrun, Wiki). Default true. */
    communityShowExternalLinks: boolean;
    /** Days a game's downloaded media (ScreenScraper images, manual PDF and cover) stays on disk after its page last opened (ADR-0051): 0-30, 0 = memory only. Default 7. */
    mediaCacheDays: number;
    /** Kill switches (migration plan M0b): comma-separated feature ids skipped at start-up. Default "". */
    disabledFeatures: string;
}
export type SettingKey = keyof Settings;

/** The "Keep downloaded media" slider (ADR-0051); the backend clamps to the same range (media_cache.MAX_DAYS). */
export const MEDIA_CACHE_DAYS = { min: 0, max: 30, step: 1, default: 7 } as const;

/** The same literal as domain/routing/policy's DEFAULT_BUCKETS (a test keeps them equal). */
const DEFAULT_BUCKETS_LITERAL: BucketsConfig = { version: 2, default: 'steam-store', rules: [], overrides: {} };

export const DEFAULTS: Settings = {
    buckets: DEFAULT_BUCKETS_LITERAL,
    defaultFullController: false,
    raHardcoreMode: true,
    routingRules: [],
    autoRoutingMode: true,
    services: DEFAULT_SERVICES,
    controllerOverrides: {},
    activityShowAddedToLibrary: true,
    activityShowFirstPlayed: true,
    activityShowAchievements: true,
    communityShowTrailers: true,
    communityShowManuals: true,
    communityShowArtworks: true,
    communityShowExternalLinks: true,
    mediaCacheDays: MEDIA_CACHE_DAYS.default,
    disabledFeatures: '',
};
