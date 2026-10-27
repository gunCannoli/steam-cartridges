/**
 * Onboarding (ADR-0088, ADR-0092): what the Library Setup window lets the user do next. Pure and `import type` free, so Node runs the
 * unit tests. The routing rule evaluation is passed in (`inScope`), never copied.
 */
import { askOf, type SetupRowLike } from './library-setup.ts';

/** The steps of the window: Metadata, Achievements, Rules, Games. */
export const STEP_SOURCES = 0;
export const STEP_RULES = 2;
export const STEP_GAMES = 3;

/** The services the Metadata step lists as on (what the panel shows as a row): the Steam mirror needs no key, the others need theirs. */
export interface SourceSwitches {
    steamStoreEnabled?: boolean;
    screenscraperEnabled?: boolean;
    igdbEnabled?: boolean;
    steamgriddbEnabled?: boolean;
}
export interface SourceKeys {
    has_screenscraper?: boolean;
    has_twitch?: boolean;
    has_sgdb?: boolean;
}

/** How many metadata sources are on: a source counts when the user turned it on (and, if it needs a key, has one). Nothing is on by default. */
export function sourcesOn(services: SourceSwitches, keys: SourceKeys | null | undefined): number {
    let n = 0;
    if (services.steamStoreEnabled === true) n++;
    if (services.screenscraperEnabled === true && keys?.has_screenscraper) n++;
    if (services.igdbEnabled === true && keys?.has_twitch) n++;
    if (services.steamgriddbEnabled === true && keys?.has_sgdb) n++;
    return n;
}

/** Games whose fetch is still pending and that the rules put in scope (not looked up, or a proposal / conflict nobody answered). */
export function pendingInScope(rows: readonly (SetupRowLike & { appid: number })[], inScope: (appid: number) => boolean): number {
    let n = 0;
    for (const r of rows) {
        const ask = askOf(r);
        if ((ask === 'detect' || ask === 'answer' || ask === 'link') && inScope(r.appid)) n++;
    }
    return n;
}

/** Games the rules put in scope, fetched or not. */
export function inScopeCount(rows: readonly { appid: number }[], inScope: (appid: number) => boolean): number {
    return rows.filter((r) => inScope(r.appid)).length;
}

/** How much a scan is: up to 150 games is quick (green), up to 250 takes a while (yellow), more is long (red). */
export type ScanLevel = 'green' | 'yellow' | 'red';
export function scanLevel(games: number): ScanLevel {
    return games <= 150 ? 'green' : games <= 250 ? 'yellow' : 'red';
}

/** The furthest step the user may open now: Metadata until one source is on, Rules until there is a rule, else the last. */
export function reachableStep(a: { sourcesOn: number; rules: number }): number {
    if (a.sourcesOn < 1) return STEP_SOURCES;
    if (a.rules < 1) return STEP_RULES;
    return STEP_GAMES;
}

/** Why Next is disabled at `step`, or undefined when it is not. */
export function nextBlockedReason(step: number, a: { sourcesOn: number; rules: number }): string | undefined {
    if (step === STEP_SOURCES && a.sourcesOn < 1) return 'Turn on at least one source to continue.';
    if (step === STEP_RULES && a.rules < 1) return 'Add a rule to continue: without one the plugin scans nothing.';
    return undefined;
}
