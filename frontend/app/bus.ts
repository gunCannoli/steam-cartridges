// app: the plugin's one event bus (migration plan M2, ADR-0039). Sensors emit into it;
// index.tsx subscribes the handlers. A handler that throws is logged and skipped.
import { logger } from "../logger";
import { createEventBus } from "../kernel/events";

export const bus = createEventBus((event, err) => logger.warn(`Handler for "${event}" failed:`, err));
