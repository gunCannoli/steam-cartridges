/**
 * Which Steam store categories a shortcut may carry (parity plan Part F,
 * ADR-0038). A shortcut is not a Steam licence, so it shows only what is true
 * of the game itself: who can play it and which controllers it supports.
 * Steam services that require a Steam licence (Cloud, Trading Cards, Workshop,
 * Remote Play Together, Family Sharing, Steam Input API, ...) are never written.
 * Pure, `import type` only, so Node can run the unit tests.
 *
 * Ids verified live 2026-09-25 against the badge table of Steam's Game Info
 * (FeaturesList) and StoreItemCache's three category groups
 * (docs/steam-components.md, "Store categories and feature badges").
 */
import type { GameCategories } from '../kernel/record';
import { MANAGED_CATEGORY_IDS, PORTABLE_CATEGORY_IDS, STEAM_ONLY_CATEGORY_IDS } from '../kernel/record.ts';

export { MANAGED_CATEGORY_IDS, PORTABLE_CATEGORY_IDS, STEAM_ONLY_CATEGORY_IDS };

const ALLOWED = new Set<number>(PORTABLE_CATEGORY_IDS);

/** Keep only allowed ids; numbers only, deduplicated, ascending. */
export function portableCategoryIds(ids: Iterable<unknown>): number[] {
    const out = new Set<number>();
    for (const id of ids) {
        if (typeof id === 'number' && ALLOWED.has(id)) out.add(id);
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * What decides the controller badge of a shortcut without Steam Store data
 * (ADR-0038 addendum). `inferred` comes from the shortcut's emulator
 * (backend emulator_controllers.lua): true, false, or undefined when unknown.
 * `defaultFull` is the setting "Default to full controller support".
 */
export interface ControllerContext {
    inferred?: boolean;
    defaultFull?: boolean;
    override?: 'full' | 'partial' | 'none' | 'auto';
}

/** Full Controller Support (28) from override first, then emulator, then user's default; else none. */
export function inferredControllerIds(ctx: ControllerContext = {}): number[] {
    if (ctx.override === 'full') return [28];
    if (ctx.override === 'partial') return [18];
    if (ctx.override === 'none') return [];
    if (ctx.inferred === true) return [28];
    if (ctx.inferred === false) return [];
    return ctx.defaultFull === true ? [28] : [];
}

/**
 * The category ids to write for one game. Steam's own ids win when the Steam
 * Store supplied them (exact); otherwise the flags of local / web metadata are
 * mapped. `remote_play_together` is a Steam service and is never mapped (ADR-0038).
 *
 * Achievements (22): written for non-store sources when `hasAchievements` is true —
 * i.e. the record has at least one achievement from any source (RetroAchievements,
 * Epic, Xbox, achievement extensions). Factual: the game has achievements. When the
 * Steam Store supplied `store_category_ids`, category 22 passes through unmodified
 * (the store already included it when appropriate).
 *
 * Split-screen and co-op are independent properties:
 * - `coop: true` → Co-op (9), from scraped fields like "Co-op" / "Co-operative play"
 * - `split_screen: true` → Shared/Split Screen (24)
 * - both → also Shared/Split Screen Co-op (39)
 * Split-screen alone does NOT imply co-op; a racing game may have split-screen
 * competition without cooperative play.
 *
 * Controller precedence (ADR-0038 addendum): the user's override for the game
 * (Game Data editor, Library Audit) > Steam Store data > emulator inference >
 * the default setting > no badge. Steam Store data is `store_category_ids` or the
 * explicit flags of a `source: 'steam-store'` record. Local and IGDB records carry
 * no controller data (web_igdb.lua and the fallback record always write
 * `full_controller = true`), so their controller flags are ignored.
 */
export function badgeCategoryIds(
    meta: { categories?: GameCategories; store_category_ids?: unknown; source?: string },
    controller: ControllerContext = {},
    opts: { hasAchievements?: boolean } = {},
): number[] {
    return withControllerOverride(badgeIdsWithoutOverride(meta, controller, opts), controller.override);
}

/** A manual choice replaces whatever controller badge the sources gave, Steam Store data included; 'auto' and unset leave it. */
function withControllerOverride(ids: number[], override: ControllerContext['override']): number[] {
    if (override !== 'full' && override !== 'partial' && override !== 'none') return ids;
    const rest = ids.filter((id) => id !== 28 && id !== 18);
    return portableCategoryIds(override === 'full' ? [...rest, 28] : override === 'partial' ? [...rest, 18] : rest);
}

function badgeIdsWithoutOverride(
    meta: { categories?: GameCategories; store_category_ids?: unknown; source?: string },
    controller: ControllerContext,
    opts: { hasAchievements?: boolean },
): number[] {
    if (Array.isArray(meta.store_category_ids)) {
        // Steam Store ids are used verbatim (they already include 22 when the game has achievements).
        // hasAchievements does not add it again on top of the store answer.
        return portableCategoryIds(meta.store_category_ids);
    }
    const c = meta.categories ?? {};
    const ids: number[] = [];
    if (c.single_player) ids.push(2);
    if (c.multiplayer) ids.push(1);
    if (c.coop) ids.push(9);
    if (c.split_screen) {
        ids.push(24); // Shared/Split Screen
        if (c.coop) ids.push(39); // Shared/Split Screen Co-op — only when both flags are set
    }
    // Achievements (22): factual — the record has at least one achievement from any source.
    if (opts.hasAchievements) ids.push(22);
    if (meta.source === 'steam-store') {
        if (c.full_controller === true) ids.push(28);
        if (c.partial_controller === true) ids.push(18);
    } else {
        ids.push(...inferredControllerIds(controller));
    }
    return portableCategoryIds(ids);
}
