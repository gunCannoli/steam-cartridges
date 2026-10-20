/**
 * What a non-Steam game is missing, as the Game Data editor shows it (ADR-0076). Pure, `import type` only, so Node runs
 * the unit tests. The Library Analytics counts and the editor's "Only games with issues" filter use this one rule.
 *
 * A game is checked only once something was fetched for it (a game still waiting for the background sync has no
 * issues yet), and never when the routing rules exclude it or the user chose to ignore its issues.
 */
import type { GameMetadata } from '../kernel/record';

/** The Game Info fields every game has (a publisher is optional), the controller badge, and the achievements section. */
export type IssueKey = 'description' | 'developers' | 'release_date' | 'controller' | 'achievements';

export const ISSUE_LABELS: Record<IssueKey, string> = {
    description: 'Description',
    developers: 'Developers',
    release_date: 'Release date',
    controller: 'Controller support',
    achievements: 'Achievements',
};

export interface IssueInputs {
    /** The stored Game Info record, if any. */
    metadata?: Partial<GameMetadata>;
    /** Matched to a Steam game or reported by a store: Steam's own Game Info and badges fill it. */
    storeData: boolean;
    /** Achievements were found (any source). */
    hasAchievements: boolean;
    /** The user marked the game as having no achievements. */
    achievementsNone: boolean;
    /** Controller support is known (override, Steam data, emulator, console release or the record's own flag). */
    controllerKnown: boolean;
    /** The routing rules exclude the game from every service. */
    excluded?: boolean;
    /** The user chose to ignore this game's issues. */
    ignored?: boolean;
}

function filled(v: unknown): boolean {
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0;
    if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && x.trim().length > 0);
    return false;
}

/** Was anything fetched for the game yet? Before that, it is waiting for the sync, not missing anything. */
export function fetched(i: IssueInputs): boolean {
    return i.metadata !== undefined || i.storeData || i.hasAchievements || i.achievementsNone;
}

/** The game's issues, in form order; empty when it has none, is excluded, ignored or not fetched yet. */
export function gameIssues(i: IssueInputs): IssueKey[] {
    if (i.excluded || i.ignored || !fetched(i)) return [];
    const out: IssueKey[] = [];
    if (!i.storeData) {
        const m = i.metadata ?? {};
        if (!filled(m.description)) out.push('description');
        if (!filled(m.developers)) out.push('developers');
        // No publisher is not an issue: many games (fan games, homebrew) have none (the user's call, 2026-10-19).
        if (!filled(m.release_date)) out.push('release_date');
    }
    if (!i.controllerKnown) out.push('controller');
    if (!i.hasAchievements && !i.achievementsNone) out.push('achievements');
    return out;
}
