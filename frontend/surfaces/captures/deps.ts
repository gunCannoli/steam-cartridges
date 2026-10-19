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
} = {
    isEnabled: () => true,
    reportError: () => {},
    activityOptions: () => ({ showAdded: true, showFirstPlayed: true, showAchievements: true }),
    bus: { emit: () => {} },
};
