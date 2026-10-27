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

export type SetupFilter = 'needs-you' | 'achievements' | 'validated' | 'all';

export const SETUP_FILTERS: readonly { id: SetupFilter; label: string }[] = [
    { id: 'needs-you', label: 'Needs you' },
    { id: 'achievements', label: 'Missing achievements' },
    { id: 'validated', label: 'Validated' },
    { id: 'all', label: 'All' },
];

/** The fields of a setup row (ports/backend SetupGame) this module reads. */
export interface SetupRowLike {
    name?: string;
    /** The Steam collections the game is in (the window's name/collection filter). */
    collections?: string[];
    status?: string;
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

export function matchesFilter(row: SetupRowLike, filter: SetupFilter): boolean {
    const ask = askOf(row);
    switch (filter) {
        case 'needs-you':
            return ask === 'detect' || ask === 'answer' || ask === 'link' || ask === 'achievements';
        case 'achievements':
            return ask === 'achievements';
        case 'validated':
            return ask === 'done';
        default:
            return true;
    }
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
