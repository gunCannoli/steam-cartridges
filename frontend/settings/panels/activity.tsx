// Settings: General (Game Info start) and the Activity Feed cards (migration plan M8c).
import { PanelSection } from "@steambrew/client";
import { useSetting } from "../settings";
import { Blocks, ToggleRow } from "../components";

// ===========================================================================
// 4. {Activity} Feed Section
// ===========================================================================

export function ActivitySection() {
    const [showInfo, setShowInfo] = useSetting("showGameInfoByDefault");
    const [showAdded, setShowAdded] = useSetting("activityShowAddedToLibrary");
    const [showFirstPlayed, setShowFirstPlayed] = useSetting(
        "activityShowFirstPlayed",
    );
    const [showAchievements, setShowAchievements] = useSetting("activityShowAchievements");

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
                        label="Achievements"
                        description="Activity feed card for each day achievements were unlocked, from every source"
                        value={showAchievements}
                        onChange={setShowAchievements}
                    />
                </>
            </Blocks>
        </PanelSection>
    );
}
