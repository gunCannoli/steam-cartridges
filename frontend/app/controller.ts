// app/controller: controller support inferred from each shortcut's emulator (backend
// emulator_controllers.lua), loaded once at start-up (ADR-0038 addendum). A factory with its backend
// passed in (M10, ADR-0044); keyed by the unsigned appid (kernel), one lookup per appid.
import { logger } from "../logger";
import { toUnsigned } from "../kernel/appid";
import type { backend as Backend } from "../ports/backend";

export interface Controller {
    load(): Promise<void>;
    /** True/false when the shortcut's emulator says so, undefined when unknown. O(1). */
    inferredFor(appid: number): boolean | undefined;
}

export function createController(deps: {
    backend: Pick<typeof Backend, "getControllerInference">;
    onLoaded?: () => void;
}): Controller {
    const inferred = new Map<number, boolean>();
    return {
        async load() {
            try {
                const res = await deps.backend.getControllerInference({ lane: "background" }); // badges are re-derived when it lands
                inferred.clear();
                for (const [key, value] of Object.entries(res?.games ?? {})) {
                    const appid = toUnsigned(key);
                    if (appid !== undefined && typeof value === "boolean") inferred.set(appid, value);
                }
                logger.info(`Controller support inferred for ${inferred.size} shortcut(s) from their emulator.`);
                deps.onLoaded?.();
            } catch (err) {
                logger.warn("Could not load controller inference; only the default setting applies.", err);
            }
        },
        inferredFor(appid) {
            const key = toUnsigned(appid);
            return key === undefined ? undefined : inferred.get(key);
        },
    };
}
