/**
 * Library Setup (ADR-0086, plan § 7.3-7.4): what a game in the setup list asks of the user, its filter and its words.
 * The backend owns the answers (choices_store.lua) and the proposals (proposals_store.lua); this only reads a row.
 * Pure, `import type` free, so Node runs the unit tests.
 */

/** What a row needs next. */
export type SetupAsk =
    | 'detect' //       not looked up yet: Detect
    | 'answer' //       a proposal: Yes / No
    | 'link' //         a conflict, or nothing found, or the proposal was refused: a manual link
    | 'achievements' // validated, no achievement source: link one or "No achievements"
    | 'done' //         validated (or set up before Library Setup existed)
    | 'skipped'; //     the user left it alone

export type SetupFilter =
    | 'uncertain'
    | 'possible'
    | 'likely'
    | 'certain'
    | 'conflicts'
    | 'no-match'
    | 'achievements'
    | 'issues'
    | 'metadata'
    | 'validated'
    | 'all'
    | 'needs-you';

export const SETUP_FILTERS: readonly { id: SetupFilter; label: string; icon?: string }[] = [
    { id: 'uncertain', label: 'Uncertain', icon: '▮▯▯▯' },
    { id: 'possible', label: 'Possible', icon: '▮▮▯▯' },
    { id: 'likely', label: 'Likely', icon: '▮▮▮▯' },
    { id: 'certain', label: 'Certain', icon: '▮▮▮▮' },
    { id: 'conflicts', label: 'Platform conflicts' },
    { id: 'no-match', label: 'No match' },
    { id: 'achievements', label: 'Missing achievements' },
    { id: 'issues', label: 'Games with issues' },
    { id: 'metadata', label: 'Metadata match' },
    { id: 'validated', label: 'Validated' },
    { id: 'all', label: 'All' },
];

/** The fields of a setup row (ports/backend SetupGame) this module reads. */
export interface SetupRowLike {
    appid?: number;
    name?: string;
    /** The Steam collections the game is in (the window's name/collection filter). */
    collections?: string[];
    status?: string;
    /** Detect's platform signals ("core snes9x", "released on PC (Microsoft Windows)"): a list, or the wire's empty object. */
    signals?: unknown;
    /** Sources that failed to answer in the last Detect (only on the row Detect returned, not stored). */
    source_issues?: unknown;
    achievements?: string;
    choice?: { kind?: string; platform?: string; steam_appid?: number; achievements?: string };
    proposal?: {
        title?: string;
        platform?: string;
        steam_appid?: number;
        steam_name?: string;
        steam_kind?: string;
        igdb_id?: number;
        igdb_name?: string;
        ss_id?: number;
        ss_name?: string;
        ra_game_id?: number;
        ra_title?: string;
        ra_by?: string;
        year?: number;
        platforms?: string[];
        genres?: string[];
        franchises?: string[];
        developers?: string[];
        themes?: string[];
        game_modes?: string[];
        perspectives?: string[];
        disputed?: boolean;
        dispute_reason?: string;
        platform_inferred?: boolean;
        candidates?: unknown;
    };
}

/**
 * A validated game with no achievement source asks for one. Not a game matched to Steam: the Steam mirror gives no achievements (ADR-0088), so
 * such a game has none and is marked so when it is confirmed (ADR-0100); one confirmed before that is not asked either.
 */
function missingAchievements(row: SetupRowLike): boolean {
    const c = row.choice;
    if (!c || c.kind !== 'validated') return false;
    if (c.platform === 'steam' || c.steam_appid !== undefined) return false;
    return !(c.achievements || row.achievements);
}

export function askOf(row: SetupRowLike): SetupAsk {
    switch (row.status) {
        case 'skipped':
            return 'skipped';
        case 'existing':
            return 'done';
        case 'validated':
            return missingAchievements(row) ? 'achievements' : 'done';
        case 'proposed':
            return row.proposal ? 'answer' : 'link';
        case 'conflict':
        case 'needs-link':
            return 'link';
        default:
            return 'detect';
    }
}

export function matchesFilter(
    row: SetupRowLike,
    filter: SetupFilter,
    inGroup?: (appid: number, group: 'all' | 'metadata' | 'achievements' | 'ignored' | 'issues' | 'missing-achievements') => boolean,
): boolean {
    const ask = askOf(row);
    switch (filter) {
        case 'uncertain':
            return certaintyOf(row).level === 'low';
        case 'possible':
            return certaintyOf(row).level === 'medium';
        case 'likely':
            return certaintyOf(row).level === 'high';
        case 'certain':
            return certaintyOf(row).level === 'verified';
        case 'conflicts':
            return row.status === 'conflict';
        case 'no-match':
            return certaintyOf(row).level === 'none';
        case 'achievements':
            // A validated game still asking for a source, or a fetched game whose stored data has no achievements (the "Games with issues" rule).
            return ask === 'achievements' || (row.appid !== undefined && !!inGroup && inGroup(row.appid, 'missing-achievements'));
        case 'issues':
            if (row.appid !== undefined && inGroup) return inGroup(row.appid, 'issues');
            return row.status === 'conflict' || certaintyOf(row).level === 'low';
        case 'metadata':
            if (row.appid !== undefined && inGroup) return inGroup(row.appid, 'metadata');
            return (
                row.proposal?.steam_appid !== undefined ||
                row.proposal?.igdb_id !== undefined ||
                row.proposal?.ss_id !== undefined ||
                row.status === 'existing' ||
                row.status === 'validated'
            );
        case 'validated':
            return ask === 'done';
        case 'needs-you':
            return ask === 'detect' || ask === 'answer' || ask === 'link' || ask === 'achievements';
        default:
            return true;
    }
}

const DEFAULT_FILTER_PRIORITY: readonly SetupFilter[] = [
    'uncertain',
    'possible',
    'likely',
    'certain',
    'conflicts',
    'no-match',
    'achievements',
    'validated',
    'all',
];

export function defaultFilter(rows: readonly SetupRowLike[]): SetupFilter {
    for (const f of DEFAULT_FILTER_PRIORITY) {
        if (f === 'all' || rows.some((r) => matchesFilter(r, f))) {
            return f;
        }
    }
    return 'all';
}

/**
 * What waits for the user (plan § 7.5): "new" = a game never answered (not looked up, a proposal, or a conflict), and
 * games validated but still missing an achievement source. Defined by the answer, not by when the game appeared, so a
 * game stays counted until the user answers it.
 */
export function waitingCounts(rows: readonly SetupRowLike[]): { fresh: number; achievements: number } {
    let fresh = 0;
    let achievements = 0;
    for (const r of rows) {
        const ask = askOf(r);
        if (ask === 'detect' || ask === 'answer' || ask === 'link') fresh++;
        else if (ask === 'achievements') achievements++;
    }
    return { fresh, achievements };
}

/** The number the Library Setup block shows as "Games to set up". */
export function waitingTotal(c: { fresh: number; achievements: number }): number {
    return c.fresh + c.achievements;
}

/** How far a game is from set up, for the list's colour: ok (blue), minor (yellow), more (amber), none (red), skipped (grey). */
export type SetupTier = 'ok' | 'minor' | 'more' | 'none' | 'skipped';

export function tierOf(row: SetupRowLike): SetupTier {
    switch (askOf(row)) {
        case 'done':
            return 'ok';
        case 'achievements':
            return 'minor';
        case 'answer':
            return 'more';
        case 'skipped':
            return 'skipped';
        default:
            // Not looked up, nothing found, or its signals disagree on the platform.
            return row.status === 'conflict' ? 'more' : 'none';
    }
}

/** The list's order: by name, ignoring case. */
export function compareNames(a: SetupRowLike, b: SetupRowLike): number {
    return (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base', numeric: true });
}

/** The list's search box: the text is part of the game's name or of one of its collections' names. */
export function matchesQuery(row: SetupRowLike, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    return (row.name ?? '').toLowerCase().includes(q) || (row.collections ?? []).some((c) => c.toLowerCase().includes(q));
}

/** The status word of § 7.4 (the busy states, Fetching and Detecting, are the window's own). */
export function statusLabel(row: SetupRowLike): string {
    const ask = askOf(row);
    if (ask === 'link' && row.status === 'conflict') return 'Conflict: needs a link';
    return {
        detect: 'Not detected yet',
        answer: 'Detected',
        link: 'Needs a link',
        achievements: 'Missing achievements',
        done: row.status === 'existing' ? 'Set up before' : 'Validated',
        skipped: 'Skipped',
    }[ask];
}

/** The proposal in words, one line per source: "Steam: Hollow Knight", "IGDB: Final Fight (1991)". */
export function proposalLines(p: SetupRowLike['proposal']): string[] {
    if (!p) return [];
    const year = p.year ? ` (${p.year})` : '';
    const out: string[] = [];
    if (p.steam_appid !== undefined) out.push(`Steam: ${p.steam_name ?? p.steam_appid}${p.steam_kind === 'edition' ? ' (an edition)' : ''}`);
    if (p.igdb_id !== undefined) out.push(`IGDB: ${p.igdb_name ?? p.igdb_id}${year}`);
    else if (p.ss_id !== undefined) out.push(`ScreenScraper: ${p.ss_name ?? p.ss_id}${year}`);
    if (p.ra_game_id !== undefined) {
        const by = p.ra_by === 'hash' ? ', matched by the ROM' : p.ra_by === 'title' ? ', matched by the title' : '';
        out.push(`RetroAchievements: ${p.ra_title ?? p.ra_game_id}${by}`);
    }
    return out;
}

/** The platforms as the source listed them: "PC (Microsoft Windows)" and its abbreviation "PC" read as one. */
function distinct(list: string[]): string[] {
    return list.filter((n, i) => list.findIndex((m) => m === n) === i && !list.some((m) => m !== n && m.toLowerCase().startsWith(n.toLowerCase())));
}

/** What the proposal says about the game besides its name, as label / value pairs (only what the source gave). */
export function proposalDetails(p: SetupRowLike['proposal']): [string, string][] {
    if (!p) return [];
    const out: [string, string][] = [];
    const add = (label: string, list: string[] | undefined, dedupe = false) => {
        if (Array.isArray(list) && list.length > 0) out.push([label, (dedupe ? distinct(list) : list).join(', ')]);
    };
    add('Platform', p.platforms, true);
    add('Genres', p.genres);
    add('Themes', p.themes);
    add('Game modes', p.game_modes);
    add('Perspectives', p.perspectives);
    add('Franchise', p.franchises);
    add('Developer', p.developers);
    return out;
}

/**
 * What the validation card shows about a game, label / value pairs: the platform, the release year, what the source said (genres,
 * developer, ...) and the Steam collections the game is in, so the user can tell whether the proposed game is the right one.
 */
export function gameFacts(row: SetupRowLike & { platform_name?: string }): [string, string][] {
    const out = proposalDetails(row.proposal);
    const has = (label: string) => out.some(([l]) => l === label);
    const platform = row.platform_name ?? inferredPlatform(row.proposal);
    if (platform && !has('Platform')) out.unshift(['Platform', platform]);
    if (row.proposal?.year) out.splice(has('Platform') || platform ? 1 : 0, 0, ['Release', String(row.proposal.year)]);
    if (Array.isArray(row.collections) && row.collections.length > 0) out.push(['Collections', row.collections.join(', ')]);
    return out;
}

/** The platform a proposal's source names when no signal did: IGDB's Windows release means PC (also for older stored proposals). */
export function inferredPlatform(p: SetupRowLike['proposal']): string | undefined {
    return Array.isArray(p?.platforms) && p.platforms.some((n) => n.toLowerCase().includes('windows')) ? 'PC' : undefined;
}

// ---------------------------------------------------------------------------------------------- certainty (review-queue plan § 3)

/** How sure the plugin is about a game's proposal, or the game's state when there is nothing to be sure about. */
export type CertaintyLevel = 'verified' | 'high' | 'medium' | 'low' | 'conflict' | 'none' | 'confirmed' | 'pending' | 'skipped';

export interface Certainty {
    level: CertaintyLevel;
    /** Why, in the user's words: shown under the level. */
    reasons: string[];
}

/** The level's mark (signal-strength bars, so it reads without colour) and its word. */
export const CERTAINTY_ICON: Record<CertaintyLevel, string> = {
    verified: '▮▮▮▮',
    high: '▮▮▮▯',
    medium: '▮▮▯▯',
    low: '▮▯▯▯',
    conflict: '⚠',
    none: '✕',
    confirmed: '✓',
    pending: '○',
    skipped: '–',
};
export const CERTAINTY_LABEL: Record<CertaintyLevel, string> = {
    verified: 'Certain',
    high: 'Likely',
    medium: 'Possible',
    low: 'Uncertain',
    conflict: 'Conflict',
    none: 'No match',
    confirmed: 'Confirmed',
    pending: 'Not looked up',
    skipped: 'Skipped',
};
/** The levels the count strip shows, most certain first. */
export const CERTAINTY_ORDER: readonly CertaintyLevel[] = ['verified', 'high', 'medium', 'low', 'conflict', 'none'];
/** Levels a bulk "Confirm" may answer for the user (plan § 3; wired in Phase E). Medium and below are looked at one by one. */
export const BULK_LEVELS: readonly CertaintyLevel[] = ['verified', 'high'];

function stripBalanced(s: string, open: string, close: string): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s[i] === open) {
            let depth = 0;
            let j = i;
            let found = false;
            while (j < s.length) {
                if (s[j] === open) depth++;
                else if (s[j] === close) {
                    depth--;
                    if (depth === 0) {
                        found = true;
                        break;
                    }
                }
                j++;
            }
            if (found) {
                i = j + 1;
                continue;
            }
        }
        out += s[i];
        i++;
    }
    return out;
}

/** The backend's title normalisation (backend/steam_store_normalize.lua `normalize`); tests/fixtures/normalize-cases.json holds both to the same answers. */
export function normalizeTitle(s: unknown): string {
    let t = String(s ?? '').toLowerCase().replace(/[™®©]/g, '');
    t = stripBalanced(t, '(', ')');
    t = stripBalanced(t, '[', ']');
    return t.replace(/[^a-z0-9]+/g, ' ').trim();
}

/** One title holds the other as whole words (the backend's `is_near`): close, not equal. */
function nearTitle(a: string, b: string): boolean {
    const x = normalizeTitle(a);
    const y = normalizeTitle(b);
    if (x === '' || y === '' || x === y) return false;
    return ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `);
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 };

/**
 * How sure the plugin is about a row (review-queue plan § 3). Pure; reads only what the row already carries, no stored field is new.
 *  verified  RetroAchievements matched the ROM by its hash
 *  high      the hit's title equals the shortcut's, and (not Steam) the platform matches a signal
 *  medium    one hit, but the title is only close, an edition, or the platform was guessed
 *  low       the title differs, or a source did not answer
 * A game with nothing proposed is `none`; a game the user answered is `confirmed`.
 */
export function certaintyOf(row: SetupRowLike): Certainty {
    const issues = listOf(row.source_issues);
    switch (askOf(row)) {
        case 'detect':
            return { level: 'pending', reasons: ['Not looked up yet'] };
        case 'skipped':
            return { level: 'skipped', reasons: ['Left alone: the plugin never fetches it'] };
        case 'done':
            return { level: 'confirmed', reasons: row.status === 'existing' ? ['Set up before Library Setup'] : [] };
        case 'achievements':
            return { level: 'confirmed', reasons: ['Achievements missing'] };
        case 'link': {
            if (row.status === 'conflict') {
                return { level: 'conflict', reasons: ['Platform signals disagree on the platform, so nothing was looked up'] };
            }
            const reasons = ['Nothing found to propose'];
            if (issues.length > 0) reasons.push('A source did not answer: try again');
            return { level: 'none', reasons };
        }
        default:
            break;
    }
    const p = row.proposal;
    if (!p) return { level: 'none', reasons: ['Nothing found to propose'] };
    if (p.ra_game_id !== undefined && p.ra_by === 'hash') {
        return { level: 'verified', reasons: ['RetroAchievements matched the ROM by its hash'] };
    }
    const named = p.steam_appid !== undefined ? p.steam_name : p.igdb_id !== undefined ? p.igdb_name : p.ss_id !== undefined ? p.ss_name : undefined;
    const found = named ?? p.title ?? '';
    const reasons: string[] = [];
    let level: 'high' | 'medium' | 'low' = 'high';
    const cap = (to: 'medium' | 'low') => {
        if (RANK[to] < RANK[level]) level = to;
    };
    if (normalizeTitle(row.name) === normalizeTitle(found)) reasons.push('The title matches exactly');
    else if (nearTitle(row.name ?? '', found)) {
        cap('medium');
        reasons.push(`The title is only close: "${found}"`);
    } else {
        cap('low');
        reasons.push(`The title differs: "${found}"`);
    }
    if (p.steam_appid !== undefined) {
        // Detect asks Steam only when no console signal says otherwise, so a Steam hit needs no platform signal of its own.
        if (p.steam_kind === 'edition') {
            cap('medium');
            reasons.push('An edition of the game, not the same title');
        }
    } else if (listOf(row.signals).some((s) => s.startsWith('released on'))) {
        cap('medium');
        reasons.push("The platform was guessed from the source's release list");
    } else if (!p.platform) {
        cap('medium');
        reasons.push('The platform is unknown');
    }
    if (p.disputed || (row.status === 'conflict' && p)) {
        cap('low');
        reasons.push(p.dispute_reason ?? 'Platform resolved from conflicting signals');
    } else if (p.platform_inferred) {
        cap('medium');
        reasons.push('Platform inferred from metadata release list');
    }
    if (issues.length > 0) {
        cap('low');
        reasons.push('A source did not answer');
    }
    return { level, reasons };
}

/** How many of `rows` sit at each level (the count strip). */
export function certaintyCounts(rows: readonly SetupRowLike[]): Record<CertaintyLevel, number> {
    const out: Record<CertaintyLevel, number> = { verified: 0, high: 0, medium: 0, low: 0, conflict: 0, none: 0, confirmed: 0, pending: 0, skipped: 0 };
    for (const r of rows) out[certaintyOf(r).level]++;
    return out;
}
