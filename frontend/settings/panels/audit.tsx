// Settings: Library Analytics (migration plan M8c). The counts link directly to Library Setup steps and filters.
import { useEffect, useRef } from "react";
import { PanelSection } from "@steambrew/client";
import { Blocks, StatRow } from "../components";
import type { SetupFilter } from "../../domain/library-setup";
import { LibrarySetupWindow } from "../setup/setup-window";
import { useLibraryIssues } from "../game-editor/library-issues";
import { useSyncProgress } from "../sync-progress";
import { usePanelContext } from "../context";
import { backend } from "../../ports/backend";

/** The setup window's share of the screen: 60% width, 80% height. */
const SETUP_SCALE = { width: 0.6, height: 0.8 };

export function RevisionSection() {
    const ctx = usePanelContext();
    const library = useLibraryIssues();
    const syncProgress = useSyncProgress();
    const { stats } = library;

    // The counts in the shared log, once per panel open (counts only, never a name): a report answers
    // "empty library or empty results" without a screenshot.
    const reported = useRef(false);
    useEffect(() => {
        if (reported.current || library.loading) return;
        reported.current = true;
        const s = library.stats;
        backend.logEvent(
            "analytics",
            `games=${s.games}, metadata=${s.metadata}, achievements=${s.achievements}, excluded=${s.excluded}, issues=${s.issues}`,
        );
    }, [library]);

    // Opens Library Setup at step 3 (Rules) or step 4 (Games) with a filter applied.
    const openSetup = (step: number, filter?: SetupFilter, e?: { currentTarget?: unknown }) => {
        const from =
            (e?.currentTarget as Element | undefined)?.ownerDocument
                ?.defaultView ?? undefined;
        ctx.dialog.open(
            <LibrarySetupWindow startStep={step} initialFilter={filter} />,
            "Library Setup",
            () => void library.refresh(),
            from,
            SETUP_SCALE,
        );
    };

    return (
        <div style={{ display: syncProgress.isSyncing ? "none" : "block" }}>
            <PanelSection title="Library Analytics">
                <Blocks>
                    <StatRow
                        label="Non-Steam Games"
                        value={stats.games}
                        onClick={() => openSetup(2)}
                    />
                    <StatRow
                        label="Metadata Match"
                        value={stats.metadata}
                        onClick={() => openSetup(3, "metadata")}
                    />
                    <StatRow
                        label="Achievements Detected"
                        value={stats.achievements}
                        onClick={() => openSetup(3, "achievements")}
                    />
                    <StatRow
                        label="Games Ignored"
                        value={stats.excluded}
                        onClick={() => openSetup(2)}
                    />
                    <StatRow
                        label="Games with issues"
                        value={stats.issues}
                        warn
                        onClick={() => openSetup(3, "issues")}
                    />
                </Blocks>
            </PanelSection>
        </div>
    );
}
