/**
 * Which games the background sync walks (app/ingest.ts needsFetch): a fallback (empty) record counts as missing
 * only when a web source can look the game up. A setup with no accounts leaves its settled games alone (ADR-0096);
 * adding an account puts them back on the list, and the backend asks those whose answerability changed.
 * Pure, so Node runs the unit tests.
 */

/** The source flags the sync reads (settings.ts ServicesConfig): on means the user picked the source. */
export interface SyncServices {
    igdbEnabled?: boolean;
    screenscraperEnabled?: boolean;
}

/** The accounts the backend holds (GetStatus, no network): on means a lookup can run, not just is picked. */
export interface WebCredentials {
    igdb: boolean;
    screenscraper: boolean;
}

/** A source that is off or has no account is never asked: it cannot fill an empty record. */
export function webCanAnswer(services: SyncServices, creds: WebCredentials): boolean {
    return (services.igdbEnabled !== false && creds.igdb) || (services.screenscraperEnabled !== false && creds.screenscraper);
}

/** The achievement sources the sync reads (settings.ts ServicesConfig): on means the source was picked. */
export interface AchServices {
    retroachievementsEnabled?: boolean;
    emulatorsEnabled?: boolean;
}

/** The achievement credentials the backend holds (GetStatus, no network): on means a lookup can run. */
export interface AchCredentials {
    ra: boolean;
}

/** An achievement lookup can answer: RetroAchievements with its account, or the emulator log readers (no account). */
export function achCanAnswer(services: AchServices, creds: AchCredentials): boolean {
    return (services.retroachievementsEnabled !== false && creds.ra) || services.emulatorsEnabled !== false;
}
