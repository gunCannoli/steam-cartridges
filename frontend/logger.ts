import { Logger } from 'steambrew-utils/logger';

/**
 * Shared logger.
 *
 * Lives in its own module so renderers can import it without depending on the
 * entry point, which would otherwise create a cycle
 * (index -> renderer -> index).
 */
export const logger = new Logger('Steam Cartridges');

/**
 * Warnings and errors also reach the plugin log file (the one users send), not only Steam's console: the code already
 * says "Could not feed AchievementsFullStore" or "Community Content loader not patched" at the moment a page breaks,
 * and a report never carried it. The entry point registers the sink once the backend is reachable; until then, and if
 * the sink throws, nothing changes for the console output.
 */
type Problem = (level: 'warn' | 'error', args: unknown[]) => void;
let sink: Problem | undefined;
export function onLoggerProblem(fn: Problem | undefined): void {
    sink = fn;
}
for (const level of ['warn', 'error'] as const) {
    const original = logger[level].bind(logger);
    logger[level] = (...args: unknown[]) => {
        original(...args);
        try {
            sink?.(level, args);
        } catch {
            /* the log must never break a caller */
        }
    };
}
