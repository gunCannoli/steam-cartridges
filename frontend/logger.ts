import { Logger } from 'steambrew-utils/logger';

/**
 * Shared logger.
 *
 * Lives in its own module so renderers can import it without depending on the
 * entry point, which would otherwise create a cycle
 * (index -> renderer -> index).
 */
export const logger = new Logger('Steam Cartridges');
