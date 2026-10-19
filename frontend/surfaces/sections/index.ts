// Surface `sections` (migration plan M3.1, ADR-0039): the only code that patches Steam's
// app detail section registry. Moved from steam/sections.ts.
import { logger } from "../../logger";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { appDetailsSections } from "../../steam/stores";
import { isShortcutAppId } from "../../kernel/appid";
import { wantsCommunitySection } from "./community.ts";

/** Steam sections a mapped shortcut gets back (parity plan C3; data comes from the native app). */
const NATIVE_SECTIONS = ["friends", "community", "achievements"] as const;

/** Steam's own Community Content section for a shortcut with no Steam match that has community media, or whose media is
 *  still being fetched (community.ts wantsCommunitySection; features plan F2; the community surface feeds its loader). */
const COMMUNITY_SECTIONS = ["community"] as const;


/** Kill switch and error counter, set by createSectionsSurface (D6). Open until then. */
let deps: SurfaceDeps = { isEnabled: () => true, reportError: () => {} };

/** Does the shortcut show our Game Info? Record-driven (migration plan M5b). */
const hasGameInfoByAppid = new Map<number, boolean>();

/** The achievements part each shortcut last rendered with (M10: a change re-renders the sections). */
const achievementsByAppid = new Map<number, unknown>();

/**
 * Re-enable the app detail sections Steam hides from non-Steam games.
 *
 * Steam builds its detail page from a section registry. For a shortcut it
 * swaps the full list for a three-item one:
 *
 *   BIsModOrShortcut() && (s = ["nonsteam", "notes", "screenshots"])
 *
 * `postgamesummary` and `activity` are dropped *before* render - not because
 * the data is missing, but because the registry filters on app type.
 *
 * For `postgamesummary` that is the whole fix: put the name back, feed Steam's
 * store, and Steam renders the rest (ADR-0009 - patch the data, not the DOM).
 *
 * `activity` is a different story, and the constant below explains why: its
 * components hit a *store* record a non-Steam game does not have, so the
 * section renders headings with empty bodies. Restoring a section is only
 * worth doing when what comes back is actually renderable - check, do not
 * assume the filter is the only obstacle.
 *
 * See docs/steam-components.md for the full registry and how it was read.
 */

/**
 * Sections we re-enable, and why each one is safe to show.
 *
 * - `postgamesummary`: Fed by us via CAppSpotlightStore; renders screenshots,
 *   clips, and achievements in the hero banner.
 * - `activity`: Fed by us via appActivityStore; renders chronological per-day
 *   activity cards. (Previously blocked by storeApp.BIsVisible(), now solved via
 *   StoreItemCache stubbing per ADR-0030).
 * - `achievements`: Fed by us via appDetailsStore; renders native achievement
 *   sidebar and progress.
 * - `info`: Desktop Game Info accordion drawer (synopsis, description, developer,
 *   publisher, release date, category badges), toggled by the ⓘ button.
 */
const RESTORED_SECTIONS = [
    // Fed by us via the spotlight store; renders screenshots and clips.
    "postgamesummary",
    // Fed by us via appActivityStore; renders chronological per-day activity cards.
    "activity",
    // Fed by us via appDetailsStore; renders native achievement sidebar and progress.
    "achievements",
    // Desktop Game Info accordion drawer
    "info",
] as const;

/**
 * Sections we remove once we have something better to show.
 *
 * `nonsteam` is Steam's grey "detailed information is unavailable because it is
 * a non-Steam game or mod" box. Now that `activity` and `postgamesummary` fill
 * `LeftColumn`, dropping `nonsteam` for games with content (`appsWithContent.has(appid)`)
 * produces a clean, fully native app details page without the disclaimer.
 *
 * When an app has NO captures or content, `nonsteam` is kept so the user still
 * sees Steam's accurate explanation rather than an awkward blank void.
 */
const REPLACED_SECTIONS: readonly string[] = ["nonsteam"];

/** Apps for which we have content worth showing instead of the placeholder. */
const appsWithContent = new Set<number>();

/**
 * Extra Steam sections per shortcut (parity plan C3). A shortcut with a Steam
 * Store match gets Steam's own `friends` and `community` sections, which then
 * load the native app's data (surfaces/native-links).
 */
const extraSections = new Map<number, readonly string[]>();

/** Set (or with `undefined`, drop) the extra sections for one shortcut; re-renders on change. */
export function setExtraSections(appid: number, names: readonly string[] | undefined): void {
    const before = extraSections.get(appid)?.join(",") ?? "";
    const after = names?.join(",") ?? "";
    if (before === after) return;
    if (names && names.length > 0) extraSections.set(appid, names);
    else extraSections.delete(appid);
    refreshInstances();
}

/**
 * Tell the section registry this app gained or lost a summary.
 *
 * The publish is async, so Steam has already rendered the page by the time it
 * finishes. The component is a MobX observer of Steam's stores, not of ours,
 * so nothing would otherwise tell it to re-run `GetSections` and pick up the
 * section we added. Only fires on an actual change, so navigation alone does
 * not force re-renders.
 */
/** captures.published (the captures surface's result): drop the placeholder once there is content. */
export function onCapturesPublished({ appid, hasContent }: { appid: number; hasContent: boolean }): void {
    setHasContent(appid, hasContent);
}

export function setHasContent(appid: number, hasContent: boolean): void {
    const had = appsWithContent.has(appid);
    if (had === hasContent) return;

    if (hasContent) appsWithContent.add(appid);
    else appsWithContent.delete(appid);

    refreshInstances();
}

interface AppOverview {
    BIsModOrShortcut?: () => boolean;
    appid?: number;
}

type GetSections = (overview: unknown, details: unknown) => Set<string>;

/** React component instance, as far as we need it. */
interface SectionsInstance {
    m_setSectionsMemo?: Set<string>;
    forceUpdate?: () => void;
}

let original: GetSections | undefined;
let patchedProto: { GetSections: GetSections } | undefined;

/**
 * Live instances of Steam's sections component.
 *
 * `GetSections` is called from `render()`, so every instance that renders a
 * page passes through our patch and registers itself here. Held weakly-ish: an
 * entry is dropped as soon as re-rendering it throws, which is what happens
 * once React has unmounted it.
 *
 * We need these because the summary is published *asynchronously*, after the
 * page has already rendered. The component is a MobX observer, but it observes
 * Steam's stores - not our set of apps-with-content - so nothing tells it to
 * re-run `GetSections` when we finish loading. Without a nudge the page keeps
 * the first render's section list, which still contains Steam's
 * "information is unavailable" placeholder. Verified live: the section set is
 * correct on a fresh call while the rendered page is stale.
 */
const instances = new Set<SectionsInstance>();

/** Re-render every live sections component. */
export function refreshSections(): void {
    refreshInstances();
}

function refreshInstances(): void {
    for (const instance of [...instances]) {
        try {
            // Drop the memo first: Steam returns the cached set when the size
            // matches, and our change swaps one member for another.
            instance.m_setSectionsMemo = undefined;
            instance.forceUpdate?.();
        } catch {
            instances.delete(instance);
        }
    }
}

let refreshScheduled = false;

/** One refreshInstances on the next tick however many records changed before it: the start-up achievements
 *  preload renders every shortcut with stored achievements in one pass (ADR-0045). */
function scheduleRefresh(): void {
    if (refreshScheduled) return;
    refreshScheduled = true;
    setTimeout(() => {
        refreshScheduled = false;
        refreshInstances();
    }, 0);
}

/** True when `overview` is a non-Steam shortcut. */
function isShortcut(overview: unknown): boolean {
    const ov = overview as AppOverview | undefined;
    if (ov?.appid && isShortcutAppId(ov.appid)) return true;
    const fn = ov?.BIsModOrShortcut;
    try {
        return typeof fn === "function" && fn.call(overview) === true;
    } catch {
        return false;
    }
}

/**
 * Patch the section registry.
 *
 * Idempotent, and a no-op if the component cannot be resolved - a Steam update
 * that moves it degrades the page to stock rather than crashing it.
 */
export function patchSections(): boolean {
    if (original) return true;

    const component = appDetailsSections();
    if (!component) return false;

    const proto = component.prototype as unknown as {
        GetSections: GetSections;
        m_setSectionsMemo?: Set<string>;
    };
    const base = proto.GetSections;
    if (typeof base !== "function") return false;

    proto.GetSections = function patchedGetSections(
        this: SectionsInstance,
        overview: unknown,
        details: unknown,
    ): Set<string> {
        // Steam's own implementation RETURNS ITS MEMO, not the set it just built:
        //
        //   ... else this.m_setSectionsMemo = a;
        //   return this.m_setSectionsMemo;
        //
        // so the returned object is sometimes a cached set from an earlier call.
        // Mutating it in place is therefore the only reliable way to influence the
        // result - editing a local copy gets silently discarded on a memo hit,
        // which is exactly how an earlier version of this patch appeared to work
        // (the summary showed) while the placeholder removal never took effect.
        const sections = base.call(this, overview, details);
        if (!deps.isEnabled("sections")) return sections;

        // Fail-open (D6): any error returns Steam's own result.
        try {
            if (!isShortcut(overview)) return sections;

            // Remember this instance so a later publish can re-render it.
            instances.add(this);

            try {
                for (const name of RESTORED_SECTIONS) sections.add(name);

                const appid = (overview as AppOverview | undefined)?.appid;
                const extra = appid !== undefined ? extraSections.get(appid) : undefined;
                if (extra) for (const name of extra) sections.add(name);

                // Only drop a section once we have something in its place; otherwise the
                // page loses an explanation and gains nothing. Empty today - see
                // REPLACED_SECTIONS.
                if (
                    appid !== undefined &&
                    (appsWithContent.has(appid) || hasGameInfoByAppid.get(appid))
                ) {
                    for (const name of REPLACED_SECTIONS) sections.delete(name);
                }

                // Keep the memo pointing at the object we just edited, so a later call
                // that hits the cache sees our version.
                this.m_setSectionsMemo = sections;
            } catch (error) {
                logger.warn("Could not adjust the section list:", error);
            }
        } catch (err) {
            deps.reportError("sections", err);
        }

        return sections;
    };

    original = base;
    patchedProto = proto;
    logger.info(
        `Restored sections for non-Steam games: ${RESTORED_SECTIONS.join(", ")}`,
    );
    return true;
}

/** Put Steam's own implementation back. Disabling the plugin leaves no trace. */
export function unpatchSections(): void {
    if (patchedProto && original) patchedProto.GetSections = original;
    original = undefined;
    patchedProto = undefined;

    appsWithContent.clear();
    extraSections.clear();
    refreshInstances();
    instances.clear();
}

/** The `sections` surface. Its API (setHasContent, setExtraSections, refreshSections) is
 *  reached by the features only through setters wired in index.tsx (D3, D4). */
export function createSectionsSurface(d: SurfaceDeps): Surface {
    deps = d;
    return {
        id: "sections",
        touches: ["CAppDetailsSections.GetSections", "CAppDetailsSections.m_setSectionsMemo"],
        reads: ["identity", "metadata", "achievements", "media"],
        install() {
            if (!patchSections()) throw new Error("CAppDetailsSections not found; sections stay stock.");
        },
        render(appid, record) {
            setExtraSections(
                appid,
                record?.identity?.data?.native
                    ? NATIVE_SECTIONS
                    : deps.isEnabled("community") && wantsCommunitySection(record?.media)
                      ? COMMUNITY_SECTIONS
                      : undefined,
            );
            // New achievements: re-render after the achievements surface fed Steam's stores in this same
            // render pass (was that surface's refreshSections call through index.tsx before M10).
            if (record?.achievements !== achievementsByAppid.get(appid)) {
                achievementsByAppid.set(appid, record?.achievements);
                if (record?.achievements) scheduleRefresh();
            }
            const meta = record?.metadata;
            const hasInfo = meta?.status === "ok" || (meta?.status === "error" && !!meta.data);
            if (hasGameInfoByAppid.get(appid) === hasInfo) return;
            hasGameInfoByAppid.set(appid, hasInfo);
            refreshInstances();
        },
        clear(appid) {
            setExtraSections(appid, undefined);
            hasGameInfoByAppid.delete(appid);
            achievementsByAppid.delete(appid);
        },
        uninstall: unpatchSections,
    };
}
