import { definePlugin, IconsModule } from "@steambrew/client";
import { logger } from "./logger";
import {
    createCapturesSurface,
    patch as patchLibraryApp,
    refresh as refreshLibraryApp,
    onSynced as capturesOnSynced,
    onUnlocked as capturesOnUnlocked,
    unpatch as unpatchLibraryApp,
} from "./surfaces/captures";
import {
    createLibraryHomeSurface,
    ready as libraryHomeReady,
    refresh as refreshLibraryHome,
} from "./surfaces/library-home";
import { createView } from "./app/view";
import { createIngest } from "./app/ingest";
import { createNativeLinksSurface, wrapNavigators } from "./surfaces/native-links";
import { createArtworkSurface } from "./surfaces/artwork";
import { createCommunitySurface } from "./surfaces/community";
import {
    initSettings,
    onSettingChange,
    resetSettings,
    setSetting,
    setting,
} from "./settings/settings";
import { SettingsPanel } from "./settings/panel";
import { createRouting } from "./app/routing";
import { createRecords, sharedRead } from "./app/records";
import { createRenderQueue } from "./app/render-queue";
import { createIdentity } from "./app/identity";
import { createMetadata } from "./app/metadata";
import { createArtwork } from "./app/artwork";
import { createMedia } from "./app/media";
import { createManuals } from "./app/manuals";
import { createLibraryStats } from "./app/library-stats";
import { fetchImage, objectUrl, objectUrlToBase64, releaseObjectUrl } from "./ports/image";
import { pdfRenderer } from "./ports/pdf";
import { createAchievements } from "./app/achievements";
import { createProvided } from "./app/provided";
import { ownedCandidates } from "./sensors/owned-apps";
import { loadStoreItem } from "./sensors/store-item";
import { createFeatureSwitches, type FeatureId } from "./safety/features";
import { beginBoot, watchBoot } from "./safety/boot";
import { lookupStored, toShortcutId, type ShortcutId } from "./kernel/appid";
import { createExtensionRegistry, type SteamCartridgesAPI } from "./kernel/extensions";
import { createImageBin } from "./kernel/image-bin";
import { createMediaBin } from "./kernel/media-bin";
import { createManualShelf } from "./kernel/manual-shelf";
import { bus } from "./app/bus";
import { installViewSensor } from "./sensors/view";
import { installLifecycleSensor } from "./sensors/lifecycle";
import { collectionsSource } from "./sensors/collections";
import { listShortcuts, shortcutTitle, shortcutData } from "./sensors/shortcuts";
import { watchProgressCache } from "./sensors/progress-cache";
import { createSurfaceRunner, type SurfaceDeps } from "./kernel/surface";
import { backend } from "./ports/backend";
import {
    createSectionsSurface,
    onCapturesPublished as sectionsOnCapturesPublished,
} from "./surfaces/sections";
import {
    createGameInfoSurface,
} from "./surfaces/game-info";
import { createController } from "./app/controller";
import { setPanelContext } from "./settings/context";
import { createGameEditor } from "./app/game-editor";
import { createSteamStore } from "./app/steam-store";
import {
    createAchievementsSurface,
    ensureAchievementsStoreHooked,
    getLocalAchievements,
    getLocalSchema,
} from "./surfaces/achievements";
import {
    createToastsSurface,
    dispatchAchievementToast,
    installTestHook as installToastTestHook,
    onUnlocked as toastsOnUnlocked,
} from "./surfaces/toasts";

/** The plugin's one FeatureSwitches instance: the kill switches come from the `disabledFeatures` setting (M0b, M9a). */
const features = createFeatureSwitches({
    readDisabled: () => String(setting("disabledFeatures") ?? ""),
    log: (level, message, err) => {
        if (level === "error") logger.error(message, err ?? "");
        else logger.warn(message, err ?? "");
    },
});
onSettingChange((key) => {
    if (key === "disabledFeatures") features.reload();
});
/** A slider drag sends many values: prune the disk cache once it settles (ADR-0051). */
let pruneTimer: ReturnType<typeof setTimeout> | undefined;
onSettingChange((key) => {
    if (key !== "mediaCacheDays") return;
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => void media.pruneCache(), 2000);
});

/** What every surface gets: the kill switches and error counter of safety/ (plan § 7.0 D6). */
const surfaceDeps: SurfaceDeps = {
    isEnabled: (id) => features.isEnabled(id as FeatureId),
    reportError: (id, err) => features.reportError(id as FeatureId, err),
};

/** The one surface runner (plan § 4.4): installs each surface in isolation, in registration order. */
const runner = createSurfaceRunner({
    isEnabled: surfaceDeps.isEnabled,
    log: (level, message, err) => {
        if (level === "error") logger.error(message, err ?? "");
        else logger.warn(message, err ?? "");
    },
});

/** Records (app/records.ts, plan M4c): the one read model every record-driven surface reads. */
const records = createRecords(bus);

/** Routing (app/routing.ts, plan M4a / ADR-0040), wired to every former buckets caller through D3 setters. */
const routing = createRouting({
    buckets: () => setting("buckets"),
    autoMode: () => setting("autoRoutingMode"),
    rules: () => setting("routingRules"),
    collections: collectionsSource,
    titleOf: shortcutTitle,
    shortcuts: listShortcuts,
    loadProfiles: async () => (await backend.getAutoRoutingProfiles())?.profiles ?? {},
    metadataAppids: () => records.store.all().filter((r) => r.metadata).map((r) => r.appid),
});

/** Render queue (app/render-queue.ts, plan § 7.0 D5): coalesces record.updated into one
 *  runner.render() per appid per tick, never from inside a Steam render. */
const renderQueue = createRenderQueue((appid, parts) => runner.render(appid, records.store.get(appid), parts));

/** Identity (app/identity.ts, plan M4c): resolves a shortcut's Steam Store match through
 *  one EnsureFresh call instead of up to three round trips. */
const identity = createIdentity({
    backend,
    records: records.store,
    owned: ownedCandidates,
    titleOf: shortcutTitle,
});

/** The start-up preloads share one GetAllRecords (ADR-0060): metadata and achievements get this backend. */
const preloadBackend = { ...backend, getAllRecords: sharedRead(() => backend.getAllRecords({ lane: "view" })) };
/** Resolves once the start-up preloads settled: ingest's needsFetch reads the records they fill (ADR-0060). */
let markPreloaded!: () => void;
const preloaded = new Promise<void>((resolve) => (markPreloaded = resolve));

/** Controller support inferred from each shortcut's emulator (app/controller.ts). */
const controller = createController({
    backend,
    onLoaded: () => {
        for (const r of records.store.all()) {
            if (r.metadata?.data) {
                metadata.rebadge(r.appid);
            }
        }
    },
});
void controller.load();

/** Metadata (app/metadata.ts, plan M5b): selects Game Info for a shortcut through one
 *  EnsureFresh call instead of the old scattered local/store/IGDB pipeline. */
const metadata = createMetadata({
    backend: preloadBackend,
    records: records.store,
    titleOf: (appid) => shortcutTitle(appid),
    ensureBase: (appid) => records.ensureBase(appid, shortcutTitle(appid) ?? ""),
    storeItemFor: (steamAppid) => loadStoreItem(steamAppid),
    allowWeb: (appid) => setting("services").igdbEnabled !== false && routing.serviceAllowed("igdb", appid),
    allowScreenscraper: (appid) => setting("services").screenscraperEnabled !== false && routing.serviceAllowed("screenscraper", appid),
    controller: (appid) => ({
        inferred: controller.inferredFor(appid),
        defaultFull: setting("defaultFullController"),
        override: lookupStored(setting("controllerOverrides"), appid),
    }),
});

/** Achievements (app/achievements.ts, plan M6b): the record's achievements part and Flow C
 *  (launch toast, in-game unlock polling, unlock announcements). */
const achievements = createAchievements({
    backend: preloadBackend,
    records: records.store,
    bus,
    ensureBase: (appid) => records.ensureBase(appid, shortcutTitle(appid) ?? ""),
    titleOf: (appid) => shortcutTitle(appid),
    routeOf: (appid) => routing.getBucket(appid),
    hardcore: () => setting("raHardcoreMode"),
    observerEnabled: () => features.isEnabled("achievements-observer"),
    providers: () => (window as any).SteamCartridges?.getAchievementProviders?.() ?? [],
    shortcutData: (appid) => shortcutData(appid),
    now: () => Date.now(),
});

/** Artwork (app/artwork.ts, plan M5c): SteamGridDB for shortcuts with no Steam match, the Steam
 *  CDN for mapped ones; the artwork surface executes the plan it puts in the record. */
/** The fetched art waiting for the artwork surface (kernel/image-bin): app/artwork puts, surfaces/artwork reads. */
const images = createImageBin();

const artwork = createArtwork({
    backend,
    records: records.store,
    bus,
    images,
    ensureBase: (appid) => records.ensureBase(appid, shortcutTitle(appid) ?? ""),
    titleOf: (appid) => shortcutTitle(appid),
    storeItemFor: (steamAppid) => loadStoreItem(steamAppid),
    fetchImage,
    allowSgdb: (appid) => setting("services").steamgriddbEnabled !== false && routing.serviceAllowed("steamgriddb", appid),
    now: () => Date.now(),
});

/** ScreenScraper images as object URLs (kernel/media-bin, features plan F2b): app/media puts, surfaces/community reads. */
const mediaBin = createMediaBin(releaseObjectUrl);

/** Community media (app/media.ts, features plan F2): the cards Steam's Community section shows for a shortcut with no Steam match. */
const media = createMedia({
    backend,
    records: records.store,
    bin: mediaBin,
    titleOf: (appid) => shortcutTitle(appid),
    allowWeb: (appid) => setting("services").igdbEnabled !== false && routing.serviceAllowed("igdb", appid),
    allowScreenscraper: (appid) => setting("services").screenscraperEnabled !== false && routing.mediaServiceAllowed("screenscraper", appid),
    toggles: () => ({
        trailers: setting("communityShowTrailers") !== false,
        artworks: setting("communityShowArtworks") !== false,
        manuals: setting("communityShowManuals") !== false,
    }),
    cacheDays: () => setting("mediaCacheDays"),
    objectUrl,
    log: (message) => logger.info(message),
});

/** Manual pages as object URLs (kernel/manual-shelf, features plan F2c): app/manuals puts, surfaces/community reads. */
const manualShelf = createManualShelf(releaseObjectUrl);

/** Manuals (app/manuals.ts, features plan F2c): renders a ScreenScraper manual when the community viewer shows its cover. */
const manuals = createManuals({
    backend,
    bus,
    shelf: manualShelf,
    renderer: pdfRenderer,
    coverCache: { objectUrl, toBase64: objectUrlToBase64 },
    cacheDays: () => setting("mediaCacheDays"),
    log: (message) => logger.info(message),
    titleOf: (appid) => shortcutTitle(appid),
    manualKeyOf: (appid) =>
        setting("communityShowManuals") === false ? undefined : records.store.get(appid as ShortcutId)?.media?.data?.items?.find((item) => item.kind === "manual")?.key,
});

/** The view pipeline (app/view.ts, plan M7b): what happens when a shortcut's page opens. */
const view = createView({ routing, identity, metadata, artwork, achievements, media });

/** What extensions push (app/provided.ts, ADR-0067): a pushed game's Game Info and media are read again at once. */
const provided = createProvided({
    backend: preloadBackend,
    records: records.store,
    ensureBase: (appid) => records.ensureBase(appid, shortcutTitle(appid) ?? ""),
    refresh: (appid) => {
        const route = routing.getBucket(appid);
        const identityPart = records.store.get(appid)?.identity;
        void metadata.ensure(appid, route, identityPart).then(() => media.ensure(appid, route, identityPart)).catch(() => undefined);
    },
});

/** Manual Steam Store mapping (app/steam-store.ts): the settings panel and the public API below. */
const steamStore = createSteamStore({ backend, identity, metadata, artwork });

/** Game Data editor (app/game-editor.ts, features plan F1): the settings popup's use cases. */
const gameEditor = createGameEditor({
    backend,
    records: records.store,
    ensureBase: (appid) => records.ensureBase(appid, shortcutTitle(appid) ?? ""),
    titleOf: (appid) => shortcutTitle(appid),
    routeOf: (appid) => routing.getBucket(appid),
    metadata,
    steamStore,
});

/** Capture stats for the library grid (app/library-stats.ts): loaded at start-up and after a game quits. */
const libraryStats = createLibraryStats({ backend });

const fetchedInSession = new Set<ShortcutId>();
/** The background job (app/ingest.ts, plan M7b): only new shortcuts at start-up; "sync now" from the panel. */
const ingest = createIngest({
    backend,
    shortcuts: () => routing.listShortcuts(),
    ready: async () => {
        await routing.ensureProfiles();
        await routing.waitForCollections();
        await preloaded;
    },
    routeOf: (appid) => routing.getBucket(appid),
    isAllowed: (appid) => routing.serviceAllowed("all", appid),
    owned: ownedCandidates,
    allowWeb: (appid) => setting("services").igdbEnabled !== false && routing.serviceAllowed("igdb", appid),
    allowScreenscraper: (appid) => setting("services").screenscraperEnabled !== false && routing.serviceAllowed("screenscraper", appid),
    hardcore: () => setting("raHardcoreMode"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    artwork,
    needsFetch: (appid) => {
        if (fetchedInSession.has(appid)) return false;
        const r = records.store.get(appid);
        const hasMeta = !!r?.metadata?.data;
        const hasAch =
            ((r?.achievements?.data as any)?.schema?.total ?? 0) > 0 ||
            r?.achievements?.source === "none";
        return !hasMeta || !hasAch;
    },
    onDone: (appid) => {
        fetchedInSession.add(appid);
    },
});

export { setSetting, resetSettings, SettingsPanel };
/** Kill switches, error counts and safe mode (migration plan M0b). */
export const safetyDiagnostics = () => features.diagnostics();
/** K6: how often Game Info was re-applied from Steam's overview rebuild (`viaTrigger`) or from a render (`viaRender`, the fallback). */
export { gameInfoRepairDiagnostics } from "./surfaces/game-info";
export const bucketReport = () => routing.bucketReport();
export const loadAutoRoutingProfiles = () => routing.loadAutoRoutingProfiles();
export const clearSteamStore = (appid: number, reject: boolean) => steamStore.clear(appid, reject);
export const setSteamStoreMapping = (appid: number, steamAppid: number, name?: string) => steamStore.setMapping(appid, steamAppid, name);
export const steamStoreState = () => steamStore.state();

export { getLocalAchievements, getLocalSchema, dispatchAchievementToast };
/** The Game Data editor (features plan F1), for CDP: tests/live/probes/game_editor.mjs calls it without clicking. */
export const gameData = gameEditor;

/** Public API (D8): the fake-achievement test hook and one store hook attempt (the surface retries on install). */
export function initAchievements(): void {
    installToastTestHook();
    ensureAchievementsStoreHooked();
}

/** Loads a shortcut's achievements into its record (`nativeAppId` overrides the identity when given). */
export async function loadAchievementsForApp(shortcutAppId: number, nativeAppId: number) {
    await achievements.ensure(shortcutAppId as ShortcutId, routing.getBucket(shortcutAppId), { native: nativeAppId || undefined });
    return getLocalAchievements(shortcutAppId) ?? null;
}

/** Unlocks one achievement (the given id, else the next locked one): persists, updates the stores, toasts. */
export const triggerAchievement = (shortcutAppId: number, targetAchievementId?: string) =>
    achievements.trigger(shortcutAppId as ShortcutId, targetAchievementId);

/** Resets all unlocked achievements for a shortcut (the plugin's own; no source files). */
export const resetAchievements = async (shortcutAppId: number) => (await achievements.reset(shortcutAppId as ShortcutId)).ok;

/**
 * Resets a shortcut's achievements and the chosen sources' files (ids from `achievementResetSources`), each backed
 * up first (ADR-0054). Resolves to what happened per source.
 */
export const resetAchievementsWithSources = (shortcutAppId: number, sources: string[]) =>
    achievements.reset(shortcutAppId as ShortcutId, sources);

/** Where a shortcut's unlocks come from besides the plugin's store, and which can be reset. */
export const achievementResetSources = (shortcutAppId: number) => achievements.resetSources(shortcutAppId as ShortcutId);

/**
 * Can a shortcut's achievements be reset at all? false for an Epic or Xbox copy: its unlocks are on the store's account
 * and come back with the next sync, so enhanced-notifications leaves it out of Reset Achievements (ADR-0056). Synchronous.
 */
export const achievementsResettable = (shortcutAppId: number) => achievements.resettable(shortcutAppId);

/** One unlock check against the backend observer; resolves to the number of new unlocks. */
export const checkObserverUnlocks = (shortcutAppId: number, nativeAppId: number, gameTitle?: string) =>
    achievements.checkNow(shortcutAppId as ShortcutId, { native: nativeAppId, title: gameTitle });

/** Starts a polling observer session while a game runs; the returned function stops it. */
export const startAchievementsObserver = (shortcutAppId: number, nativeAppId: number, gameTitle?: string) =>
    achievements.startSession(shortcutAppId as ShortcutId, { native: nativeAppId, title: gameTitle });

export { registerSummaryProvider } from "./surfaces/captures";
export { jsxDiagnostics } from "./steam/gamepad-appid";
export { nativeSectionsDiagnostics } from "./surfaces/native-links";
export { communityDiagnostics } from "./surfaces/community";
/** Backend calls: the one running, what waits per lane, the last 200 with queue and run times (ADR-0060, for CDP). */
export { transportDiagnostics as rpcDiagnostics } from "./ports/transport";
export type {
    SummaryContext,
    SummaryContribution,
    SummaryProvider,
} from "./surfaces/captures";
export type { SteamCartridgesAPI };

/** Install API globally on window.SteamCartridges and flush any queued registrations. */
export function initGlobalExtensionAPI(): SteamCartridgesAPI {
    const existing = (window as any).SteamCartridges;
    if (existing && existing.version) return existing as SteamCartridgesAPI;

    const api = createExtensionRegistry({
        reportUnlocks: (appid, unlocks, opts) => achievements.ingestExternal(appid, unlocks, opts),
        reportGame: (appid, game, opts) => provided.reportGame(appid, game, opts),
        reportAchievementSet: (appid, set, opts) => achievements.ingestProvidedSet(appid, set, opts),
        forgetGame: (appid, opts) => provided.forgetGame(appid, opts),
    });
    (window as any).SteamCartridges = api;

    // Flush any queue from plugins loaded before steam-cartridges
    const queue = (window as any).__STEAM_CARTRIDGES_QUEUE__;
    if (Array.isArray(queue)) {
        for (const item of queue) {
            try {
                if (item.type === "achievement") api.registerAchievementProvider(item.provider);
                else if (item.type === "library") api.registerLibraryProvider(item.provider);
                else if (item.type === "settings") api.registerSettingsPanel(item.panel);
                else if (item.type === "summary") api.registerSummaryProvider(item.provider);
            } catch {
                // Fail-silent isolation (ADR-0014)
            }
        }
        delete (window as any).__STEAM_CARTRIDGES_QUEUE__;
    }
    // Extensions that loaded first wait for this (ADR-0067: steam-cartridges-third-party starts its pushes on it). A window
    // event because it crosses plugins: each plugin's bundle has its own kernel/events bus.
    try {
        window.dispatchEvent(new CustomEvent("steam-cartridges:ready", { detail: api }));
    } catch {
        // Fail-silent isolation (ADR-0014)
    }

    return api;
}

const LEGACY_PLUGINS = [
    "non-steam-games-activity",
    "non-steam-games-activity-dev",
    "steamgriddb-artwork",
    "steamgriddb-artwork-dev",
];

async function init() {
    const extensionApi = initGlobalExtensionAPI();
    // Panels reach the app only through this context (plan M8b, § 7.0 D3).
    setPanelContext({
        routing: {
            listCollections: () => routing.listCollections(),
            listShortcuts: () => routing.listShortcuts(),
            membersOf: (id) => routing.membersOf(id),
            shortcutName: (appid) => routing.listShortcuts().find((s) => s.appid === appid)?.name ?? String(appid),
            getAutoRoutingProfile: (appid) => routing.getAutoRoutingProfile(appid),
            serviceAllowed: (service, appid) => routing.serviceAllowed(service, appid),
            reloadProfiles: () => routing.loadAutoRoutingProfiles(),
        },
        ingest: {
            progress: ingest.getSyncProgress,
            onProgress: ingest.onSyncProgress,
            trigger: ingest.triggerSync,
            start: ingest.startSync,
        },
        records: {
            achievementsOf: (appid) => achievements.summary(appid),
            refreshAchievements: async (appid) => {
                const id = toShortcutId(appid);
                if (id !== undefined) {
                    await achievements.ensure(id, routing.getBucket(id), { force: true });
                }
            },
        },
        controller: {
            load: controller.load,
            inferredFor: controller.inferredFor,
            refresh: (appid) => {
                const id = toShortcutId(appid);
                if (id !== undefined) metadata.rebadge(id);
            },
        },
        steamStore: { setMapping: steamStore.setMapping },
        editor: gameEditor,
    });

    // The sections surface drops Steam's placeholder once captures has published content (captures.published).
    bus.on("captures.published", sectionsOnCapturesPublished);

    // Record-driven surfaces (sections, native-links, captures; plan § 7.0 D4) render on a
    // timer after record.updated, never from inside a Steam render (plan § 7.0 D5).
    bus.on("record.updated", ({ appid, parts }) => renderQueue.push(appid, parts));
    // When achievements load (or reload) for a shortcut that already has metadata, re-derive the
    // badge_category_ids so the Achievements tag (22) is added/removed in the game-info surface
    // without waiting for a full metadata refresh. Analogous to controller.onLoaded → metadata.rebadge.
    bus.on("record.updated", ({ appid, parts }) => {
        if (parts.includes("achievements") && records.store.get(appid)?.metadata?.data) {
            metadata.rebadge(appid);
        }
    });
    // The record must exist before anything writes a part to it (kernel/record.ts update()
    // is a no-op for an unknown appid); every view ensures its base record first.
    bus.on("shortcut.viewed", ({ appid }) => records.ensureBase(appid, shortcutTitle(appid) ?? ""));

    // Settings first: the Game Info gate reads them (ADR-0033).
    await initSettings();
    // Downloaded media of games not opened within the setting's days leaves the disk (ADR-0051). Local files only.
    void media.pruneCache();

    // ===== Safety (migration plan M0b) =====
    // Kill switches come from the `disabledFeatures` setting. Two starts in a row that
    // never finished cleanly switch safe mode on (capture tier only, ADR-0012).
    features.reload();
    try {
        const boot = beginBoot(window.localStorage);
        if (boot.safeMode) {
            features.setSafeMode(true);
            logger.error(
                `Safe mode: the last ${boot.unclean} starts did not finish cleanly; only sections and captures are on.`,
            );
        }
        watchBoot(window.localStorage, () => features.errorCount(), window);
    } catch (e) {
        logger.warn("Boot sentinel unavailable.", e);
    }

    // ===== Legacy guard =====
    // Log only; never skip init.
    try {
        const list = (window as any).PLUGIN_LIST ?? {};
        for (const name of LEGACY_PLUGINS) {
            if (list[name]) {
                logger.error(
                    `Legacy plugin "${name}" is still loaded next to steam-cartridges; disable it (sections and hooks would be installed twice).`,
                );
            }
        }
    } catch {
        /* diagnostics only */
    }

    // ===== Native sections =====
    // Steam hides Post-Game Summary from shortcuts with an app-type filter in its
    // section registry. Putting the name back is what makes the native component
    // render at all, so nothing else matters if this fails.
    runner.register(createSectionsSurface(surfaceDeps));
    runner.installAll();
    if (features.isEnabled("sections") && !runner.status().find((s) => s.id === "sections")?.installed) {
        logger.error(
            "Could not restore Steam's app detail sections; summaries are unavailable.",
        );
    }

    // ===== Captures (surfaces/captures, plan M3.2) =====
    // Post-Game Summary, a shortcut's activity feed and StoreItemCache immunity (store-cache). The captures in
    // the feed are the steam-captured-activity plugin's (docs/steam-captured-activity.md).
    runner.register(
        createCapturesSurface({
            ...surfaceDeps,
            activityOptions: () => ({
                showAdded: setting("activityShowAddedToLibrary") !== false,
                showFirstPlayed: setting("activityShowFirstPlayed") !== false,
                showAchievements: setting("activityShowAchievements") !== false,
            }),
            bus,
        }),
    );
    runner.installAll();

    // ===== Native sections for mapped games (parity plan C) =====
    // Steam's own Links / Friends / Community sections read the native appid
    // of a Steam Store match; unmatched shortcuts keep Steam's stock sections.
    runner.register(createNativeLinksSurface(surfaceDeps));
    // Community media in Steam's own Community section for shortcuts with no Steam match (surfaces/community, features plan F2).
    runner.register(
        createCommunitySurface({
            ...surfaceDeps,
            imageOf: (appid, key) => mediaBin.get(appid, key),
            manualOf: (appid, key) => manualShelf.get(appid, key),
            coverOf: (appid, key) => manualShelf.cover(appid, key),
            onManuals: (listener) => manualShelf.subscribe(listener),
            bus,
        }),
    );
    // Custom artwork slots and logo position for mapped games (surfaces/artwork, plan M3.9).
    runner.register(
        createArtworkSurface({ ...surfaceDeps, images, bus }),
    );
    runner.installAll();
    artwork.install();
    manuals.install();

    // ===== Native Achievements Subsystem =====
    // Steam's achievement stores (surfaces/achievements, plan M3.5); the loader below feeds them.
    runner.register(createAchievementsSurface(surfaceDeps));
    // Steam's notification toasts (surfaces/toasts, plan M3.6).
    runner.register(createToastsSurface(surfaceDeps));
    runner.installAll();
    features.run("achievements", () => initAchievements());
    // Flow C (launch toast, unlock polling, quit reload) and the unlock announcements.
    achievements.install();
    // Each new unlock: a toast and a Post-Game Summary line; a launch with achievements: the launch toast.
    bus.on("achievements.unlocked", toastsOnUnlocked);
    bus.on("achievements.unlocked", capturesOnUnlocked);
    // An extension's pushed unlocks (ADR-0067): the Post-Game Summary only, never a toast.
    bus.on("achievements.synced", capturesOnSynced);

    // ===== Game Info (surfaces/game-info, plan M3.3; record-driven from M5b) =====
    // Steam's Game Info components and AppOverview hooks; app/metadata (below) fills the record.
    runner.register(
        createGameInfoSurface({
            ...surfaceDeps,
            metadataOf: (appid) => records.store.get(appid as ShortcutId)?.metadata?.data,
        }),
    );
    runner.installAll();

    // ===== Game Info data (ex steamgriddb-artwork) =====
    // Not awaited: a failure here must not affect activity (ADR-0010).
    // Controller support loads once (above); its onLoaded re-derives the badges, so nothing waits for it here.
    features.run("game-info", async () => {
        await routing.ensureProfiles().catch((e) => logger.warn("Loading auto-routing profiles failed:", e));
        view.init();
        bus.on("shortcut.viewed", ({ appid }) => void view.onSourceView(appid));
    });

    // ===== Stored Game Info and achievements, from start-up (ADR-0045, ADR-0060) =====
    // Disk only, one shared GetAllRecords in the view lane, before the library grid: what is stored shows at once.
    // Achievements need no library: Steam's appStore is not populated yet at this point.
    const preloads: Promise<unknown>[] = [];
    features.run("game-info", () => {
        preloads.push(metadata.preload().catch((e) => {
            features.reportError("game-info", e);
            logger.error("Game Info preload failed; activity is unaffected.", e);
        }));
    });
    features.run("achievements", () => {
        preloads.push(achievements.preload().catch((e) => {
            features.reportError("achievements", e);
            logger.error("Achievements preload failed; a game's page still loads them.", e);
        }));
        // Steam rebuilds its progress cache from its own file after login, which drops what we wrote before
        // it: write again whenever the cache map appears or is replaced (bounded; ADR-0045).
        watchProgressCache(() => achievements.rerenderAll());
        // Which shortcuts an extension reported (ADR-0067): their achievements are pushed, never polled.
        preloads.push(provided.preload().catch((e) => logger.warn("Pushed-games preload failed.", e)));
    });
    void Promise.allSettled(preloads).then(() => markPreloaded());

    // ===== Library grid =====
    // Fills in last-played dates Steam does not have, from capture timestamps.
    if (features.isEnabled("library-home")) await libraryStats.load();
    runner.register(createLibraryHomeSurface({ ...surfaceDeps, stats: libraryStats }));
    runner.installAll();
    await libraryHomeReady();

    // ===== App detail pages =====
    // Publishing is keyed on the app, not the window: Steam's store is global, so
    // one publish serves every window showing that game.

    // Views come from the view sensor (sensors/view, migration plan M2), for desktop
    // and Big Picture alike.
    bus.on("shortcut.viewed", ({ appid }) => {
        if (features.isEnabled("native-links")) features.run("native-links", () => wrapNavigators());
        if (features.isEnabled("captures")) void patchLibraryApp(appid);
        void achievements.context(appid).then((ctx) => extensionApi.notifyAppViewed(ctx));
    });
    bus.on("shortcut.left", ({ appid }) => {
        if (features.isEnabled("captures")) unpatchLibraryApp(appid);
    });

    // ===== Refresh after play =====
    // Quitting a game is exactly when new screenshots and clips exist, so
    // invalidate then rather than polling (ADR-0007). Launch and quit come from the
    // lifecycle sensor (sensors/lifecycle, migration plan M2).

    // Achievements (launch toast, unlock polling, reload on quit) run in app/achievements.ts.
    bus.on("shortcut.quit", ({ appid, name }) => {
        logger.info(`${name} closed; refreshing its activity.`);
        void refreshLibraryApp(appid);
        void libraryStats.load().then(refreshLibraryHome);
        void achievements.context(appid).then((ctx) => extensionApi.notifyAppQuit({ ...ctx, displayName: name ?? ctx.displayName }));
    });
    bus.on("shortcut.launched", ({ appid }) => {
        void achievements.context(appid).then((ctx) => extensionApi.notifyAppLaunched(ctx));
    });

    // ===== Sensors (migration plan M2) =====
    // Installed after every subscriber above: they report the current page and the
    // windows already open immediately.
    installViewSensor(bus);
    installLifecycleSensor(bus);

    logger.info("Ready. Non-Steam games now use Steam's own detail sections.");
    // Automatically start background sync for un-scraped games after startup
    features.run("background-sync", () => ingest.triggerSync(3000));
}

export default definePlugin(() => {
    init().catch((e) => logger.error("Plugin init failed.", e));

    // Guardrail: Ensure Settings panel and Plugin list are indexed under both "steam-cartridges"
    // and "steam-cartridges-dev" so Millennium can always resolve the settings page.
    setTimeout(() => {
        try {
            const panels = (window as any).MILLENNIUM_SIDEBAR_NAVIGATION_PANELS;
            if (panels) {
                if (panels["steam-cartridges"] && !panels["steam-cartridges-dev"]) {
                    panels["steam-cartridges-dev"] = panels["steam-cartridges"];
                }
                if (panels["steam-cartridges-dev"] && !panels["steam-cartridges"]) {
                    panels["steam-cartridges"] = panels["steam-cartridges-dev"];
                }
            }
            const pl = (window as any).PLUGIN_LIST;
            if (pl) {
                if (pl["steam-cartridges"] && !pl["steam-cartridges-dev"]) {
                    pl["steam-cartridges-dev"] = pl["steam-cartridges"];
                }
                if (pl["steam-cartridges-dev"] && !pl["steam-cartridges"]) {
                    pl["steam-cartridges"] = pl["steam-cartridges-dev"];
                }
            }
        } catch {
            // ignore
        }
    }, 0);

    return {
        title: "Steam Cartridges",
        icon: <IconsModule.Settings />,
        content: <SettingsPanel />,
    };
});
