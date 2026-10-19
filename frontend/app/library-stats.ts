// app/library-stats: capture stats per shortcut (newest screenshot or clip, screenshot count), loaded
// through the backend port for the library-home surface (M10: the surface no longer calls the
// backend; it reads these O(1)). Loaded at start-up and again after a game quits.
import { logger } from "../logger.ts";
import { toUnsigned } from "../kernel/appid.ts";
import type { backend as Backend } from "../ports/backend";

export interface CaptureStats {
    /** Unix seconds of the newest screenshot or recording. */
    newest: number;
    screenshots: number;
}

export interface LibraryStats {
    /** Re-read the stats from the backend; a failure keeps the previous ones. */
    load(): Promise<void>;
    /** O(1): this shortcut's stats, or undefined when it has no captures. */
    get(appid: number): CaptureStats | undefined;
    size(): number;
}

export function createLibraryStats(deps: { backend: Pick<typeof Backend, "getLibraryStats"> }): LibraryStats {
    let stats = new Map<number, CaptureStats>();
    return {
        async load() {
            try {
                const raw = await deps.backend.getLibraryStats({ lane: "background" });
                const next = new Map<number, CaptureStats>();
                for (const [key, value] of Object.entries(raw ?? {})) {
                    const id = toUnsigned(key);
                    if (id === undefined) continue;
                    next.set(id, { newest: value?.newest ?? 0, screenshots: value?.screenshots ?? 0 });
                }
                stats = next;
                logger.info(`Library stats loaded for ${stats.size} non-Steam game(s).`);
            } catch (error) {
                // The grid is an enhancement; failing to load stats must not break it.
                logger.error("Could not load library stats:", error);
            }
        },
        get(appid) {
            const id = toUnsigned(appid);
            return id === undefined ? undefined : stats.get(id);
        },
        size: () => stats.size,
    };
}
