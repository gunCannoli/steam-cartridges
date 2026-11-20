// Kernel: Extension / Expansion Provider API (Phase 9 & ADR-0012/ADR-0013/ADR-0014).
// Allows external plugins (steam-cartridges-local, steam-cartridges-third-party, etc.)
// to contribute achievements, game installations, settings tabs, and summary evidence
// to steam-cartridges without tight coupling or host crashes.

export interface AppContext {
    appid: number;
    gameid: string;
    isShortcut: boolean;
    displayName: string;
    exe?: string;
    launchOptions?: string;
    /** The Steam app this shortcut maps to (0 or absent = none). Extensions never read the core's files for it (ADR-0063). */
    nativeAppid?: number;
    /** The ids of the record's achievement schema, when it has one (lets a provider decode CRC-keyed files). */
    achievementIds?: string[];
}

export interface ReportUnlocksOptions {
    /** The reporting provider's id, for the log. */
    providerId: string;
    /** true: record and show in the Post-Game Summary, no toast (a first snapshot of old unlocks). */
    silent?: boolean;
}

export interface AchievementSchemaItem {
    id: string;
    name: string;
    description: string;
    icon: string;
    unlockedIcon?: string;
    hidden?: boolean;
}

export interface AchievementUnlockItem {
    id: string;
    unlockedAt: number; // unix timestamp
}

export interface AchievementSourceProvider {
    id: string;
    name: string;
    priority?: number;
    match(context: AppContext): Promise<boolean> | boolean;
    getSchema?(context: AppContext): Promise<AchievementSchemaItem[] | null>;
    getUnlocks(context: AppContext): Promise<AchievementUnlockItem[]>;
    reset?(context: AppContext): Promise<{ cleared: number; ok: boolean; backupPath?: string }>;
}

/** Options of every push (ADR-0067). */
export interface ReportOptions {
    /** The reporting extension's id, for the log and the record. */
    providerId: string;
}

/** A community media item an extension pushes: public URLs only. */
export interface ProvidedMediaItem {
    kind: "screenshot" | "artwork" | "video";
    url?: string;
    thumb?: string;
    youtube?: string;
    width?: number;
    height?: number;
    title?: string;
}

/**
 * A game an extension found behind a shortcut (ADR-0067: an Epic or Xbox copy). The core keeps it as one more source:
 * after a Steam match, before IGDB and ScreenScraper. Every field but `source` is optional.
 */
export interface ProvidedGameReport {
    /** The data's source id, shown in the record ("epic", "xbox", ...). */
    source: string;
    /** The source's name for the game (helps the Steam match). */
    title?: string;
    /** Game Info in the metadata part's shape (title, description, developers, publishers, genres, categories,
     *  release_date, ...). */
    metadata?: Record<string, unknown>;
    media?: ProvidedMediaItem[];
    /**
     * The game's own art, as https image URLs (the core fetches them): the three capsule slots and the library icon. Used only
     * for a shortcut with no Steam match, on the slots nobody filled (a grid file, or a slot already tried, is never touched),
     * the way SteamGridDB's art is (app/artwork).
     */
    artwork?: ProvidedArtwork;
    /**
     * May the core fill what the extension's data leaves empty (genres, publishers, trailers, more screenshots) from IGDB and
     * ScreenScraper, whichever the user turned on. Default true. Steam's own page info always comes first for a game on Steam.
     */
    fill?: boolean;
}

export interface ProvidedArtwork {
    portrait?: string;
    hero?: string;
    wide?: string;
    icon?: string;
}

/** The player's achievements as an extension found them (ADR-0067). The extension is the truth: unlocks are replaced. */
export interface ProvidedAchievementSet {
    source: string;
    /** The list's id within the source (Epic: the namespace; Xbox: the title id): stored as "<source>_<key>". */
    key: string;
    /** The list's title, for the log. */
    title?: string;
    achievements: (AchievementSchemaItem & { global_pct?: number })[];
    /** Unlock time (unix seconds) per achievement id. */
    unlocks: Record<string, number>;
}

export interface InstalledGame {
    store: "epic" | "xbox" | string;
    id: string;
    title: string;
    installPath: string;
    executable: string;
    launchUri?: string;
    iconUrl?: string;
}

export interface LibrarySourceProvider {
    id: string;
    name: string;
    getInstalledGames(): Promise<InstalledGame[]>;
    onBeforeLaunch?(context: AppContext): Promise<{ cancel?: boolean }>;
    onAfterQuit?(context: AppContext): Promise<void>;
}

/**
 * ADR-0108: an expansion's settings live in its own panel in Millennium's plugin list. Registering lets the core show a
 * one-line pointer to it; `render` (expansions built before ADR-0108) is kept in the type and never called.
 */
export interface SettingsPanelExtension {
    id: string;
    title: string;
    order?: number;
    render?: () => any;
}

/**
 * API 1.3.0 (ADR-0107): a shortcut's install state as the extension that owns it knows it. false draws Steam's own
 * not-installed state (greyed tile, out of the Installed collection, Install on the play bar). The one shape:
 * domain/install-state.ts checks it, surfaces/install-state/core.ts draws it.
 */
export interface ReportedInstallState {
    installed: boolean;
    /** Bytes on disk when installed, bytes required when not (0 or absent = unknown). */
    sizeBytes?: number;
    /** Steam's Install button routes to the extension's handler. */
    canInstall?: boolean;
    canUninstall?: boolean;
}

/** Where Steam's Install / Uninstall for a reported shortcut goes: the handler whose `id` is the report's `providerId`. */
export interface InstallHandler {
    id: string;
    install(appid: number): Promise<{ ok: boolean }> | { ok: boolean };
    uninstall?(appid: number): Promise<{ ok: boolean }> | { ok: boolean };
}

export interface SummaryContribution {
    text: string;
    icon?: string;
    timestamp?: number;
}

export interface SummaryProvider {
    id: string;
    name: string;
    getContributions?(context: AppContext): Promise<SummaryContribution[]>;
}

export interface SteamCartridgesAPI {
    readonly version: string;
    registerAchievementProvider(provider: AchievementSourceProvider): () => void;
    registerLibraryProvider(provider: LibrarySourceProvider): () => void;
    registerSettingsPanel(panel: SettingsPanelExtension): () => void;
    registerSummaryProvider(provider: SummaryProvider): () => void;
    getAchievementProviders(): AchievementSourceProvider[];
    getLibraryProviders(): LibrarySourceProvider[];
    getSettingsPanels(): SettingsPanelExtension[];
    onAppViewed(cb: (context: AppContext) => void): () => void;
    onAppLaunched(cb: (context: AppContext) => void): () => void;
    onAppQuit(cb: (context: AppContext) => void): () => void;
    notifyAppViewed(context: AppContext): void;
    notifyAppLaunched(context: AppContext): void;
    notifyAppQuit(context: AppContext): void;
    /** Extensions push unlocks; the core canonicalizes, persists and announces them (ADR-0063). */
    reportUnlocks(appid: number, unlocks: AchievementUnlockItem[], opts: ReportUnlocksOptions): Promise<{ accepted: string[] }>;
    /** Extensions push a game's Game Info and media (ADR-0067). Resolves to whether the core's copy changed. */
    reportGame(appid: number, game: ProvidedGameReport, opts: ReportOptions): Promise<{ ok: boolean; changed?: boolean }>;
    /**
     * Extensions push a player's whole achievement set (ADR-0067). Resolves to the ids that were new and, once Steam's own list
     * is the primary source of icons and rarity, `kept`: the ids whose icon is still the extension's own (no Steam match, or no
     * Steam icon), which the extension may still fix (a wide picture cut to a square).
     */
    reportAchievementSet(appid: number, set: ProvidedAchievementSet, opts: ReportOptions): Promise<{ ok: boolean; new: string[]; kept?: string[] }>;
    /** The shortcut is no longer the extension's game: drop what it pushed (ADR-0067). */
    forgetGame(appid: number, opts: ReportOptions): Promise<{ ok: boolean }>;
    /** 1.3.0: the shortcut's install state (ADR-0107). Not kept across Steam starts: report again at start-up. */
    reportInstallState(appid: number, state: ReportedInstallState, opts: ReportOptions): Promise<{ ok: boolean }>;
    /** 1.3.0: Steam's Install / Uninstall for the appids this extension reported call the handler, never Steam's wizard. */
    registerInstallHandler(handler: InstallHandler): () => void;
}

/** Where the registry hands what extensions push (index.tsx wires app/achievements and app/provided). */
export interface ExtensionSink {
    reportUnlocks: SteamCartridgesAPI["reportUnlocks"];
    reportGame: SteamCartridgesAPI["reportGame"];
    reportAchievementSet: SteamCartridgesAPI["reportAchievementSet"];
    forgetGame: SteamCartridgesAPI["forgetGame"];
    reportInstallState: SteamCartridgesAPI["reportInstallState"];
    registerInstallHandler: SteamCartridgesAPI["registerInstallHandler"];
}

const NO_SINK: ExtensionSink = {
    reportUnlocks: async () => ({ accepted: [] }),
    reportGame: async () => ({ ok: false }),
    reportAchievementSet: async () => ({ ok: false, new: [] }),
    forgetGame: async () => ({ ok: false }),
    reportInstallState: async () => ({ ok: false }),
    registerInstallHandler: () => () => undefined,
};

export interface RegistryOptions {
    /** One line for the plugin log (index.tsx passes the logger). */
    log?: (line: string) => void;
}

export function createExtensionRegistry(sink: Partial<ExtensionSink> = {}, opts: RegistryOptions = {}): SteamCartridgesAPI {
    const out: ExtensionSink = { ...NO_SINK, ...sink };
    /** A push never throws into the extension (ADR-0014): a failure resolves to the sink's empty answer. */
    function guarded<K extends Exclude<keyof ExtensionSink, "registerInstallHandler">>(key: K, args: Parameters<ExtensionSink[K]>): ReturnType<ExtensionSink[K]> {
        const empty = (NO_SINK[key] as (...a: unknown[]) => Promise<unknown>)();
        try {
            return ((out[key] as (...a: unknown[]) => Promise<unknown>)(...args).catch(() => empty)) as ReturnType<ExtensionSink[K]>;
        } catch {
            return empty as ReturnType<ExtensionSink[K]>;
        }
    }
    const achievementProviders: AchievementSourceProvider[] = [];
    const libraryProviders: LibrarySourceProvider[] = [];
    const settingsPanels: SettingsPanelExtension[] = [];
    const summaryProviders: SummaryProvider[] = [];
    const viewListeners: ((context: AppContext) => void)[] = [];
    const launchListeners: ((context: AppContext) => void)[] = [];
    const quitListeners: ((context: AppContext) => void)[] = [];

    const api: SteamCartridgesAPI = {
        version: "1.3.0",
        registerAchievementProvider(provider) {
            const existing = achievementProviders.findIndex((p) => p.id === provider.id);
            if (existing >= 0) achievementProviders.splice(existing, 1);
            achievementProviders.push(provider);
            achievementProviders.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
            return () => {
                const idx = achievementProviders.indexOf(provider);
                if (idx >= 0) achievementProviders.splice(idx, 1);
            };
        },
        registerLibraryProvider(provider) {
            const existing = libraryProviders.findIndex((p) => p.id === provider.id);
            if (existing >= 0) libraryProviders.splice(existing, 1);
            libraryProviders.push(provider);
            return () => {
                const idx = libraryProviders.indexOf(provider);
                if (idx >= 0) libraryProviders.splice(idx, 1);
            };
        },
        registerSettingsPanel(panel) {
            if (!panel || typeof panel.id !== "string" || typeof panel.title !== "string") return () => undefined;
            const existing = settingsPanels.findIndex((p) => p.id === panel.id);
            if (existing < 0) {
                try {
                    opts.log?.(`[extensions] ${panel.id} registered; its settings are in its own plugin panel${panel.render ? " (its old in-panel render is ignored)" : ""}`);
                } catch {
                    // logging never breaks a registration (ADR-0014)
                }
            }
            if (existing >= 0) settingsPanels.splice(existing, 1);
            settingsPanels.push(panel);
            settingsPanels.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
            return () => {
                const idx = settingsPanels.indexOf(panel);
                if (idx >= 0) settingsPanels.splice(idx, 1);
            };
        },
        registerSummaryProvider(provider) {
            const existing = summaryProviders.findIndex((p) => p.id === provider.id);
            if (existing >= 0) summaryProviders.splice(existing, 1);
            summaryProviders.push(provider);
            return () => {
                const idx = summaryProviders.indexOf(provider);
                if (idx >= 0) summaryProviders.splice(idx, 1);
            };
        },
        getAchievementProviders: () => achievementProviders.slice(),
        getLibraryProviders: () => libraryProviders.slice(),
        getSettingsPanels: () => settingsPanels.slice(),
        onAppViewed(cb) {
            viewListeners.push(cb);
            return () => {
                const idx = viewListeners.indexOf(cb);
                if (idx >= 0) viewListeners.splice(idx, 1);
            };
        },
        onAppLaunched(cb) {
            launchListeners.push(cb);
            return () => {
                const idx = launchListeners.indexOf(cb);
                if (idx >= 0) launchListeners.splice(idx, 1);
            };
        },
        onAppQuit(cb) {
            quitListeners.push(cb);
            return () => {
                const idx = quitListeners.indexOf(cb);
                if (idx >= 0) quitListeners.splice(idx, 1);
            };
        },
        notifyAppViewed(ctx) {
            for (const cb of viewListeners) {
                try {
                    cb(ctx);
                } catch {
                    // Fail-silent isolation (ADR-0014)
                }
            }
        },
        notifyAppLaunched(ctx) {
            for (const cb of launchListeners) {
                try {
                    cb(ctx);
                } catch {
                    // Fail-silent isolation (ADR-0014)
                }
            }
        },
        reportUnlocks(appid, unlocks, opts) {
            return guarded("reportUnlocks", [appid, Array.isArray(unlocks) ? unlocks : [], opts]);
        },
        reportGame(appid, game, opts) {
            return guarded("reportGame", [appid, game, opts]);
        },
        reportAchievementSet(appid, set, opts) {
            return guarded("reportAchievementSet", [appid, set, opts]);
        },
        forgetGame(appid, opts) {
            return guarded("forgetGame", [appid, opts]);
        },
        reportInstallState(appid, state, opts) {
            return guarded("reportInstallState", [appid, state, opts]);
        },
        registerInstallHandler(handler) {
            if (!handler || typeof handler.id !== "string" || typeof handler.install !== "function") return () => undefined;
            try {
                const off = out.registerInstallHandler(handler);
                return typeof off === "function" ? off : () => undefined;
            } catch {
                return () => undefined; // Fail-silent isolation (ADR-0014)
            }
        },
        notifyAppQuit(ctx) {
            for (const cb of quitListeners) {
                try {
                    cb(ctx);
                } catch {
                    // Fail-silent isolation (ADR-0014)
                }
            }
        },
    };

    return api;
}
