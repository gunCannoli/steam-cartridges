// Settings panel shell (migration plan M8c): the sections in their fixed order.
import { useEffect, useState } from "react";
import { Field, PanelSection } from "@steambrew/client";
import { MetadataSection } from "./panels/metadata";
import { AchievementsSection } from "./panels/achievements";
import { ActivitySection } from "./panels/activity";
import { CommunitySection } from "./panels/community";
import { RulesSection } from "./panels/rules";
import { RevisionSection } from "./panels/audit";
import { LibrarySetupSection } from "./panels/library-setup";

import { SyncProgressBar } from "./sync-progress";
import { Blocks, COLUMN_STYLE, ItemRow } from "./components";

/** ADR-0108: an expansion's settings live in its own panel in Millennium's plugin list; here, one line pointing there. */
function ExpansionsSection({ panels }: { panels: { id: string; title: string }[] }) {
    if (panels.length === 0) return null;
    return (
        <PanelSection title="Expansions">
            <Blocks>
                <>
                    {panels.map((p) => (
                        <ItemRow key={p.id}>
                            <Field label={p.title} description="Its settings are in its own panel in Millennium's plugin list." />
                        </ItemRow>
                    ))}
                </>
            </Blocks>
        </PanelSection>
    );
}

export function SettingsPanel() {
    const [, tick] = useState(0);
    // Until onboarding is finished or skipped every other section is greyed out (an answer we cannot read blocks nothing).
    const [onboarded, setOnboarded] = useState<boolean | undefined>();

    // Periodic refresh so live collections, shortcuts, and extension panels remain synced
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 3000);
        return () => clearInterval(t);
    }, []);

    const extPanels = ((window as any).SteamCartridges?.getSettingsPanels?.() ?? []) as Array<{ id: string; title: string }>;

    return (
        <div style={{ ...COLUMN_STYLE, paddingBottom: "70px", position: "relative" }}>
            <SyncProgressBar />
            <LibrarySetupSection onOnboarded={setOnboarded} />
            <div
                style={{ ...COLUMN_STYLE, ...(onboarded === false ? { opacity: 0.4, pointerEvents: "none" } : {}) }}
                inert={onboarded === false}
            >
            <MetadataSection />
            <AchievementsSection />
            <ActivitySection />
            <CommunitySection />
            <ExpansionsSection panels={extPanels} />
            <RulesSection />
            <RevisionSection />

            </div>
        </div>
    );
}
