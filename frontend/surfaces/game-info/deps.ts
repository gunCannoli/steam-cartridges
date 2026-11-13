// Surface `game-info`: what the composition root gives it (migration plan M3.3, § 7.0 D6).
// Set once by createGameInfoSurface; open defaults until then.
import type { GameMetadata, PlaytimeEntry } from "../../kernel/record";
import type { SurfaceDeps } from "../../kernel/surface";

export const deps: SurfaceDeps & {
    /** O(1) cached Game Info of a shortcut (records.get(appid)?.metadata?.data, M5b): a pure read of the record. */
    metadataOf(appid: number): GameMetadata | undefined;
    /** Setting showGameInfoByDefault: a shortcut's Game Info starts open (Steam's own start for a shortcut). Default off. */
    showByDefault(): boolean;
    /** Maximum length for game descriptions, breaking cleanly at sentence end. Default 360. */
    descriptionMaxLength(): number;
    /** A shortcut's tracked playtime when the Track Playtime setting is on (app/playtime), else undefined: Steam's own. */
    playtimeOf(appid: number): PlaytimeEntry | undefined;
    /** No tracked entry yet but Steam's details carry a count: seed it (app/playtime adopt), so every view agrees. */
    playtimeAdopt(appid: number, steam: { minutes: number; last_played: number }): void;
    /** Remove the steam-non-steam-playtimes plugin's injected play-bar stats (ours show in Steam's own components). */
    hideOtherPlaytime(): boolean;
} = {
    playtimeOf: () => undefined,
    playtimeAdopt: () => {},
    hideOtherPlaytime: () => false,
    showByDefault: () => false,
    descriptionMaxLength: () => 360,
    isEnabled: () => true,
    reportError: () => {},
    metadataOf: () => undefined,
};
