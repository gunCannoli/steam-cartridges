// Setting keys, types and defaults (migration plan M8a). Type-only imports: node can load this file
// directly, which is how tests/settings-defaults.test.ts pins every default (do-not-touch 1).
import type { BucketsConfig, RoutingRule } from '../domain/routing/policy';
import type { PlaytimeMode } from '../domain/merged-plugins';

export interface ServicesConfig {
    steamStoreEnabled: boolean;
    screenscraperEnabled: boolean;
    igdbEnabled: boolean;
    /** SteamGridDB artwork for shortcuts with no Steam match (M5c). */
    steamgriddbEnabled: boolean;
    retroachievementsEnabled: boolean;
    emulatorsEnabled: boolean;
    /** Native PC ports with their own trophy files (Bloodborne PC, Dusklight, ...). */
    nativePortsEnabled?: boolean;
    rpcs3Enabled?: boolean;
}

/** Nothing is on until the user picks it in onboarding (ADR-0091): no opinionated defaults. */
export const DEFAULT_SERVICES: ServicesConfig = {
    steamStoreEnabled: false,
    screenscraperEnabled: false,
    igdbEnabled: false,
    steamgriddbEnabled: false,
    retroachievementsEnabled: false,
    emulatorsEnabled: false,
    nativePortsEnabled: false,
    rpcs3Enabled: false,
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
    /** Service enablement toggles. */
    services: ServicesConfig;
    /** Per-game controller overrides. */
    controllerOverrides: Record<string, ControllerOverride>;
    /** Games whose issues the user chose to ignore (Game Data editor): left out of "games with issues". */
    ignoredIssues: Record<string, boolean>;
    /** Open a shortcut's Game Info when its page opens. Off by default: Steam keeps an owned game's collapsed behind the info button. */
    showGameInfoByDefault: boolean;
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
    /** Maximum length for game descriptions, breaking cleanly at the nearest sentence. Default 360. */
    descriptionMaxLength: number;
    /** Watch emulator achievement files and game logs in real-time while playing (ADR-0063). Default true. */
    watchLocalAchievements: boolean;
    /**
     * Captures in every game's Activity feed: "{Username} captured" days with Steam's own Post-Game Summary cards, for Steam
     * games and non-Steam games (the steam-captured-activity plugin, merged 2026-11-12). Default false, and never switched on
     * for the user: no migration from that plugin (it froze Steam at start, 2026-11-13; ADR-0105).
     */
    capturedActivity: boolean;
    /**
     * Track how long non-Steam games are played and show it in Steam's own Play Time and Last Played stats (the
     * steam-non-steam-playtimes plugin's job, taken over 2026-11-12). "auto" (default): on, unless steam-non-steam-playtimes
     * is loaded, which then keeps doing the job alone (2026-11-13, the user: a 0.7.3 user's backend crashed at every start
     * with both installed). "on" / "off": the user's own choice, whatever is installed. Replaces `trackPlaytime` (0.7.3),
     * which the migration set by itself and so is not a choice of the user's: it is ignored.
     */
    playtimeMode: PlaytimeMode;
    /** The one-time sessions import from steam-non-steam-playtimes ran (only once our playtime is active). */
    playtimeMigrated: boolean;
    /** Kill switches (migration plan M0b): comma-separated feature ids skipped at start-up. Default "". */
    disabledFeatures: string;
}
export type SettingKey = keyof Settings;

/** The "Keep downloaded media" slider (ADR-0051); the backend clamps to the same range (media_cache.MAX_DAYS). */
export const MEDIA_CACHE_DAYS = { min: 0, max: 30, step: 1, default: 7 } as const;

/** The "Maximum Game Description Length" slider; default 360 characters. */
export const DESCRIPTION_MAX_LENGTH = { min: 100, max: 1000, step: 20, default: 360 } as const;

/** The same literal as domain/routing/policy's DEFAULT_BUCKETS (a test keeps them equal). */
const DEFAULT_BUCKETS_LITERAL: BucketsConfig = { version: 2, default: 'steam-store', rules: [], overrides: {} };

export const DEFAULTS: Settings = {
    buckets: DEFAULT_BUCKETS_LITERAL,
    defaultFullController: false,
    raHardcoreMode: true,
    routingRules: [],
    services: DEFAULT_SERVICES,
    controllerOverrides: {},
    ignoredIssues: {},
    // Everything optional starts off on a first initialization (ADR-0091): the user turns on what they want.
    showGameInfoByDefault: false,
    activityShowAddedToLibrary: false,
    activityShowFirstPlayed: false,
    activityShowAchievements: false,
    communityShowTrailers: false,
    communityShowManuals: false,
    communityShowArtworks: false,
    communityShowExternalLinks: false,
    mediaCacheDays: MEDIA_CACHE_DAYS.default,
    descriptionMaxLength: DESCRIPTION_MAX_LENGTH.default,
    watchLocalAchievements: true,
    capturedActivity: false,
    playtimeMode: 'auto',
    playtimeMigrated: false,
    disabledFeatures: '',
};
