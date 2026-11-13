// Settings: General (Game Info start) and the Activity Feed cards (migration plan M8c).
import { Field, PanelSection } from "@steambrew/client";
import { DESCRIPTION_MAX_LENGTH, useSetting } from "../settings";
import { Blocks, ItemRow, SliderRow, ToggleRow } from "../components";

// ===========================================================================
// 4. General & {Activity} Feed Section
// ===========================================================================

export function ActivitySection() {
    const [showInfo, setShowInfo] = useSetting("showGameInfoByDefault");
    const [showAdded, setShowAdded] = useSetting("activityShowAddedToLibrary");
    const [showFirstPlayed, setShowFirstPlayed] = useSetting(
        "activityShowFirstPlayed",
    );
    const [showAchievements, setShowAchievements] = useSetting(
        "activityShowAchievements",
    );
    const [watchLocal, setWatchLocal] = useSetting("watchLocalAchievements");
    const [capturedActivity, setCapturedActivity] = useSetting("capturedActivity");
    const [trackPlaytime, setTrackPlaytime] = useSetting("trackPlaytime");
    const [maxDescLength, setMaxDescLength] = useSetting(
        "descriptionMaxLength",
    );

    return (
        <PanelSection title="General">
            <Blocks>
                <>
                    <ToggleRow
                        label="Show Game Info"
                        description="Open Game Info on every game's page. Off: it stays behind the info button, like Steam's own games"
                        value={showInfo}
                        onChange={setShowInfo}
                    />
                    <ToggleRow
                        label="Added to Library"
                        description="Activity feed card when a game is added to the library"
                        value={showAdded}
                        onChange={setShowAdded}
                    />
                    <ToggleRow
                        label="First Time Played"
                        description="Activity feed card when a game is played for the first time"
                        value={showFirstPlayed}
                        onChange={setShowFirstPlayed}
                    />
                    <ToggleRow
                        label="Achievements Activity"
                        description="Activity feed card for each day achievements were unlocked, from every source"
                        value={showAchievements}
                        onChange={setShowAchievements}
                    />
                    <ToggleRow
                        label="Captured Activity"
                        description="Your screenshots and recordings in every game's Activity feed, Steam games included"
                        value={capturedActivity}
                        onChange={setCapturedActivity}
                    />
                    <ToggleRow
                        label="Track Playtime"
                        description="Count how long non-Steam games are played and show it in Steam's Play Time"
                        value={trackPlaytime}
                        onChange={setTrackPlaytime}
                    />
                    <ToggleRow
                        label="Track Local Achievements"
                        description="Detect achievement unlocks by monitoring local files and game logs"
                        value={watchLocal !== false}
                        onChange={setWatchLocal}
                    />
                </>
                <>
                    <ItemRow>
                        <Field
                            label="Game Description Length"
                            description="Characters limit, ending at the nearest complete sentence."
                            bottomSeparator="none"
                        />
                    </ItemRow>
                    <SliderRow
                        value={maxDescLength}
                        min={DESCRIPTION_MAX_LENGTH.min}
                        max={DESCRIPTION_MAX_LENGTH.max}
                        step={DESCRIPTION_MAX_LENGTH.step}
                        suffix=" chars"
                        resetValue={DESCRIPTION_MAX_LENGTH.default}
                        onChange={setMaxDescLength}
                        trailing
                    />
                </>
            </Blocks>
        </PanelSection>
    );
}
