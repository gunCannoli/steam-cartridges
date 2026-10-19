/**
 * Pure bucket resolution (ADR-0033, amended by ADR-0036). Its one runtime import (the kernel)
 * carries `.ts`, so Node can run the unit tests with type stripping.
 *
 * ADR-0036: a shortcut that no rule claims gets the fixed default bucket
 * `steam-store`. A steam-store game with no Steam match falls back to web
 * scraping at view time (app/view.ts), not here. Each collection
 * rule may narrow itself with title patterns (include / exclude).
 */
import { NON_STEAM_APPID_MIN } from '../../kernel/appid.ts';

export type Bucket = 'steam-store' | 'web-scraping' | 'none';

export interface CollectionRule {
    /** Steam collection id. */
    id: string;
    /** Display name when the rule was saved; used to re-find a re-created collection. */
    name: string;
    /** The collection's bucket. 'none' = never fetch for its games (local Game Info only). */
    bucket: Bucket;
    /** Title patterns. Empty = every game in the collection. */
    include: string[];
    /** Title patterns. A matching game skips this rule (and falls through to later rules / default). */
    exclude: string[];
}

export interface BucketsConfig {
    version: 2;
    /** Fixed (ADR-0036); validation forces it. */
    default: 'steam-store';
    /** ORDER = precedence; a collection id appears once. */
    rules: CollectionRule[];
    /** Shortcut appid (string) -> bucket. Shortcuts only: no native data is persisted. */
    overrides: Record<string, Bucket>;
}

export interface Resolution {
    bucket: Bucket;
    via: 'override' | 'collection' | 'default' | 'not-a-shortcut' | 'pending';
    collectionId?: string;
    conflict?: { collectionIds: string[]; buckets: Bucket[] };
}

export type MembersOf = (collectionId: string) => ReadonlySet<number> | undefined;
export type TitleOf = (appid: number) => string | undefined;

export const MAX_PATTERNS = 32;
export const MAX_PATTERN_LENGTH = 100;

export const DEFAULT_BUCKETS: BucketsConfig = { version: 2, default: 'steam-store', rules: [], overrides: {} };

const isBucket = (v: unknown): v is Bucket => v === 'steam-store' || v === 'web-scraping' || v === 'none';

function patterns(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const p of v) {
        if (typeof p !== 'string') continue;
        const t = p.trim();
        if (t && t.length <= MAX_PATTERN_LENGTH && !out.includes(t)) out.push(t);
        if (out.length >= MAX_PATTERNS) break;
    }
    return out;
}

/** "a, b ,,c" -> ["a", "b", "c"] (the settings panel's text field). */
export function splitPatterns(text: string): string[] {
    return patterns(String(text ?? '').split(','));
}

/**
 * Case-insensitive title match, never a regex built from user text.
 * No wildcard: substring match. With `*` (any run) or `?` (one character): the
 * whole title must match.
 */
export function matchesPattern(title: string, pattern: string): boolean {
    const t = String(title ?? '').toLowerCase();
    const p = String(pattern ?? '').toLowerCase();
    if (!p) return false;
    if (!p.includes('*') && !p.includes('?')) return t.includes(p);
    let ti = 0;
    let pi = 0;
    let star = -1;
    let mark = 0;
    while (ti < t.length) {
        if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
            ti++;
            pi++;
        } else if (pi < p.length && p[pi] === '*') {
            star = pi++;
            mark = ti;
        } else if (star >= 0) {
            pi = star + 1;
            ti = ++mark;
        } else {
            return false;
        }
    }
    while (pi < p.length && p[pi] === '*') pi++;
    return pi === p.length;
}

/** Does this rule claim a game with this title? */
export function ruleAppliesTo(rule: CollectionRule, title: string | undefined): boolean {
    const name = title ?? '';
    if (rule.include.length > 0 && !rule.include.some((p) => matchesPattern(name, p))) return false;
    return !rule.exclude.some((p) => matchesPattern(name, p));
}

/** Never throws. Migrates v1 `assignments`; drops malformed entries; forces `default: 'steam-store'`. */
export function validateConfig(raw: unknown): BucketsConfig {
    const out: BucketsConfig = { version: 2, default: 'steam-store', rules: [], overrides: {} };
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as Record<string, unknown>;

    // v1 stored `assignments` (no patterns); v2 stores `rules` (ADR-0036).
    const list = Array.isArray(r.rules) ? r.rules : Array.isArray(r.assignments) ? r.assignments : [];
    const seen = new Set<string>();
    for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        const { id, name, bucket, include, exclude } = a as Record<string, unknown>;
        if (typeof id !== 'string' || id === '' || seen.has(id) || !isBucket(bucket)) continue;
        seen.add(id);
        out.rules.push({
            id,
            name: typeof name === 'string' ? name : id,
            bucket,
            include: patterns(include),
            exclude: patterns(exclude),
        });
    }

    if (r.overrides && typeof r.overrides === 'object' && !Array.isArray(r.overrides)) {
        for (const [key, bucket] of Object.entries(r.overrides)) {
            if (!/^\d+$/.test(key) || Number(key) < NON_STEAM_APPID_MIN || !isBucket(bucket)) continue;
            out.overrides[key] = bucket;
        }
    }
    return out;
}

export function resolveBucket(
    appid: number,
    cfg: BucketsConfig,
    membersOf: MembersOf,
    titleOf: TitleOf = () => undefined,
    autoProfile?: AutoRoutingProfile,
): Resolution {
    if (!(appid >= NON_STEAM_APPID_MIN)) return { bucket: 'none', via: 'not-a-shortcut' };

    const override = cfg.overrides[String(appid)];
    if (override) return { bucket: override, via: 'override' };

    let winner: CollectionRule | undefined;
    const ids: string[] = [];
    const buckets: Bucket[] = [];
    let title: string | undefined;
    let titleRead = false;
    for (const rule of cfg.rules) {
        if (!membersOf(rule.id)?.has(appid)) continue;
        if (rule.include.length > 0 || rule.exclude.length > 0) {
            if (!titleRead) {
                title = titleOf(appid);
                titleRead = true;
            }
            if (!ruleAppliesTo(rule, title)) continue;
        }
        winner ??= rule;
        ids.push(rule.id);
        buckets.push(rule.bucket);
    }
    if (!winner) {
        if (autoProfile?.category === 'retroarch' || autoProfile?.category === 'console_emulator') {
            return { bucket: 'web-scraping', via: 'default' };
        }
        return { bucket: cfg.default, via: 'default' };
    }

    const res: Resolution = { bucket: winner.bucket, via: 'collection', collectionId: winner.id };
    if (new Set(buckets).size > 1) res.conflict = { collectionIds: ids, buckets };
    return res;
}

/** Appids (from `appids`) claimed by rules of different buckets. */
export function findConflicts(
    cfg: BucketsConfig,
    membersOf: MembersOf,
    appids: Iterable<number>,
    titleOf: TitleOf = () => undefined,
): { appid: number; resolution: Resolution }[] {
    const out: { appid: number; resolution: Resolution }[] = [];
    for (const appid of appids) {
        const resolution = resolveBucket(appid, cfg, membersOf, titleOf);
        if (resolution.conflict && resolution.via === 'collection') out.push({ appid, resolution });
    }
    return out;
}

// ---------------------------------------------------------------------------
// General Multi-Service Routing Engine
// ---------------------------------------------------------------------------

export type ServiceTarget =
    | 'all'
    | 'steam-store'
    | 'steam_store'
    | 'screenscraper'
    | 'igdb'
    | 'steamgriddb'
    | 'retroachievements'
    | 'console_emulators'
    | 'rpcs3'
    | 'none';

export type RuleAction = 'include' | 'exclude';

export type ConditionType = 'collection' | 'game_name' | 'regex';

export interface RoutingRule {
    id: string;
    name: string;
    service: ServiceTarget | string;
    action: RuleAction;
    conditionType: ConditionType;
    pattern: string;
    enabled?: boolean;
}

export function matchesRegex(text: string, pattern: string): boolean {
    try {
        const re = new RegExp(pattern, 'i');
        return re.test(text);
    } catch {
        return false;
    }
}

export type AutoCategory = 'retroarch' | 'console_emulator' | 'pc';

export interface AutoRoutingProfile {
    category: AutoCategory;
    program?: string;
}

/**
 * Checks whether a service is allowed under auto-mode defaults:
 * - retroarch: retroachievements + web scraping (screenscraper, igdb, steamgriddb). No steam_store, no console_emulators.
 * - console_emulator: console_emulators + web scraping (screenscraper, igdb, steamgriddb). No steam_store, no retroachievements.
 * - pc: steam_store + local achievements. No retroachievements, no console_emulators, no screenscraper.
 */
export function isServiceAllowedByAutoMode(
    service: ServiceTarget | string,
    category?: AutoCategory,
): boolean {
    if (!category) return true;
    const svc = service.toLowerCase().replace(/-/g, '_');
    if (svc === 'all') return true;

    if (category === 'retroarch') {
        if (svc === 'retroachievements') return true;
        if (svc === 'screenscraper' || svc === 'igdb' || svc === 'steamgriddb') return true;
        if (svc === 'steam_store' || svc === 'console_emulators' || svc === 'rpcs3') return false;
        return true;
    }

    if (category === 'console_emulator') {
        if (svc === 'console_emulators' || svc === 'rpcs3') return true;
        if (svc === 'screenscraper' || svc === 'igdb' || svc === 'steamgriddb') return true;
        if (svc === 'retroachievements') return true;
        if (svc === 'steam_store') return false;
        return true;
    }

    if (category === 'pc') {
        if (svc === 'steam_store') return true;
        if (svc === 'igdb' || svc === 'steamgriddb') return true;
        if (svc === 'screenscraper' || svc === 'retroachievements' || svc === 'console_emulators' || svc === 'rpcs3') return false;
        return true;
    }

    return true;
}

/**
 * Evaluates whether a given service is allowed for a shortcut based on ordered rules,
 * falling back to Auto Mode classification if enabled.
 */
export function isServiceAllowed(
    service: ServiceTarget,
    _appid: number,
    title: string,
    collectionIds: string[],
    rules: RoutingRule[] = [],
    autoModeEnabled = false,
    autoProfile?: AutoRoutingProfile,
): boolean {
    if (rules && rules.length > 0) {
        for (const rule of rules) {
            if (rule.enabled === false) continue;
            const targetServices = (rule.service || 'all').split(',').map((s) => s.trim().toLowerCase());
            const svc = service.toLowerCase();
            const matchesService =
                targetServices.includes('all') ||
                targetServices.includes(svc) ||
                (svc === 'console_emulators' && targetServices.includes('rpcs3')) ||
                (svc === 'rpcs3' && targetServices.includes('console_emulators')) ||
                (svc === 'steam_store' && targetServices.includes('steam-store')) ||
                (svc === 'steam-store' && targetServices.includes('steam_store'));

            if (!matchesService) continue;

            let matched = false;
            const subPatterns = rule.pattern.split(',').map((s) => s.trim()).filter(Boolean);
            const patternsToTest = subPatterns.length > 0 ? subPatterns : [rule.pattern.trim()];

            if (rule.conditionType === 'collection') {
                matched = collectionIds.some((cid) =>
                    patternsToTest.some((pat) =>
                        cid.toLowerCase() === pat.toLowerCase() ||
                        matchesPattern(cid, pat)
                    )
                );
            } else if (rule.conditionType === 'game_name') {
                matched = patternsToTest.some((pat) => matchesPattern(title, pat));
            } else if (rule.conditionType === 'regex') {
                matched = matchesRegex(title, rule.pattern);
            }

            if (matched) {
                if (rule.action === 'exclude') return false;
                if (rule.action === 'include') return true;
            }
        }
    }

    // No custom rule matched: apply auto-mode default if enabled
    if (autoModeEnabled && autoProfile?.category) {
        return isServiceAllowedByAutoMode(service, autoProfile.category);
    }

    return true;
}

/**
 * `isServiceAllowed` for the Community media sources. Auto Mode keeps ScreenScraper off a PC game (its Game Info comes from
 * the Steam store and IGDB), but ScreenScraper has a PC platform and community images for PC games (AM2R, a fan game, is
 * on it), so for media alone the PC exclusion is lifted. The user's own rules are still evaluated first and win.
 */
export function isMediaServiceAllowed(
    service: ServiceTarget,
    appid: number,
    title: string,
    collectionIds: string[],
    rules: RoutingRule[] = [],
    autoModeEnabled = false,
    autoProfile?: AutoRoutingProfile,
): boolean {
    const profile = service === 'screenscraper' && autoProfile?.category === 'pc' ? undefined : autoProfile;
    return isServiceAllowed(service, appid, title, collectionIds, rules, autoModeEnabled, profile);
}
