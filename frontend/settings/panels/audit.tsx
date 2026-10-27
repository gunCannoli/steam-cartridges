// Settings: Library Analytics (migration plan M8c). The counts, and the Game Data editor where every fix happens
// (ADR-0076: the Review popup is gone; the editor shows the games with issues and tints what they miss).
import { DialogButton, PanelSection } from "@steambrew/client";
import { Blocks, BUTTON_STYLE, FullWidthRows, StatRow } from "../components";
import type { LibraryGroup } from "../../domain/game-issues";
import { GameDataEditor } from "../game-editor/modal";
import { useLibraryIssues } from "../game-editor/library-issues";
import { useSyncProgress } from "../sync-progress";
import { usePanelContext } from "../context";

export function RevisionSection() {
    const ctx = usePanelContext();
    const library = useLibraryIssues();
    const syncProgress = useSyncProgress();
    const { stats } = library;

    // Its own window as big as the screen (ADR-0076); the counts are read again once it closes.
    const open = (group: LibraryGroup, e?: { currentTarget?: unknown }) => {
        const from = (e?.currentTarget as Element | undefined)?.ownerDocument?.defaultView ?? undefined;
        ctx.dialog.open(<GameDataEditor group={group} />, "Game Data", () => void library.refresh(), from);
    };

    return (
        <div style={{ display: syncProgress.isSyncing ? "none" : "block" }}>
            <PanelSection title="Library Analytics">
                <Blocks>
                    <>
                        <StatRow label="Non-Steam Games" value={stats.games} />
                        <StatRow label="Metadata Match" value={stats.metadata} />
                        <StatRow label="Achievements Match" value={stats.achievements} />
                        <StatRow label="Ignored by your rules" value={stats.excluded} />
                        <StatRow label="Games with issues" value={stats.issues} warn />
                    </>
                    {stats.issues > 0 && (
                        <FullWidthRows label="Fix issues" description="Opens the games with missing information, the first one chosen">
                            <DialogButton onClick={(e) => open("issues", e)} style={{ ...BUTTON_STYLE, width: "100%" }}>
                                Fix {stats.issues} game{stats.issues === 1 ? "" : "s"}
                            </DialogButton>
                        </FullWidthRows>
                    )}
                    <FullWidthRows label="Edit Game MetaData" description="Edit any game's details, links, achievements and controller support">
                        <DialogButton onClick={(e) => open("all", e)} style={{ ...BUTTON_STYLE, width: "100%" }}>
                            Manual Edit
                        </DialogButton>
                    </FullWidthRows>
                </Blocks>
            </PanelSection>
        </div>
    );
}
