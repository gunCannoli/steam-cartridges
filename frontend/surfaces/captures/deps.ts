// Surface `captures`: what the composition root gives it (migration plan M3.2, § 7.0 D3/D6).
// Set once by createCapturesSurface; open defaults until then.
import type { EventBus } from "../../kernel/events";
import type { SurfaceDeps } from "../../kernel/surface";

export interface ActivityOptions {
    /** Show Steam's "Added to library" event (setting activityShowAddedToLibrary). */
    showAdded: boolean;
    /** Show Steam's "Played for the first time" event (setting activityShowFirstPlayed). */
    showFirstPlayed: boolean;
    /** Show Steam's "achieved" event for each day with unlocks (setting activityShowAchievements, ADR-0056). */
    showAchievements: boolean;
}

export const deps: SurfaceDeps & {
    activityOptions(): ActivityOptions;
    /** Where the surface reports what it published (`captures.published`). */
    bus: Pick<EventBus, "emit">;
    /** One line in the plugin log under [activity] (what a feed showed and why a part was left out), sent on the bus. */
    report(message: string): void;
    /** One line in the plugin log under [captures] (screenshot and media sensors), sent on the bus. */
    log(message: string): void;
    /** HTTP status of an image on Steam's loopback server asked without the browser cache; undefined when it could not be asked. */
    probeStatus(url: string): Promise<number | undefined>;
    /** File names of indexed screenshots whose file is gone from disk (deleted by hand); null when unknown. */
    missingScreenshots(gameid: string): Promise<{ indexed: number; missing: string[] } | null>;
} = {
    missingScreenshots: async () => null,
    probeStatus: async () => undefined,
    log(message) {
        deps.bus.emit("surface.report", { area: "captures", message });
    },
    isEnabled: () => true,
    reportError: () => {},
    activityOptions: () => ({ showAdded: true, showFirstPlayed: true, showAchievements: true }),
    bus: { emit: () => {} },
    report(message) {
        deps.bus.emit("surface.report", { area: "activity", message });
    },
};
