// Settings: Activity Feed (migration plan M8c, moved verbatim).
import { PanelSection } from "@steambrew/client";
import { useSetting } from "../settings";
import { Blocks, ToggleRow } from "../components";

// ===========================================================================
// 4. {Activity} Feed Section
// ===========================================================================

export function ActivitySection() {
    const [showAdded, setShowAdded] = useSetting("activityShowAddedToLibrary");
    const [showFirstPlayed, setShowFirstPlayed] = useSetting(
        "activityShowFirstPlayed",
    );
    const [showAchievements, setShowAchievements] = useSetting("activityShowAchievements");

    return (
        <PanelSection title="Activity Feed">
            <Blocks>
                <>
                    <ToggleRow
                        label="Added to Library"
                        description="Card when game is added to library"
                        value={showAdded}
                        onChange={setShowAdded}
                    />
                    <ToggleRow
                        label="First Time Played"
                        description="Card when game is played for first time"
                        value={showFirstPlayed}
                        onChange={setShowFirstPlayed}
                    />
                    <ToggleRow
                        label="Achievements"
                        description="Card for each day achievements were unlocked, from every source"
                        value={showAchievements}
                        onChange={setShowAchievements}
                    />
                </>
            </Blocks>
        </PanelSection>
    );
}
