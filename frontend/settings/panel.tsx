// Settings panel shell (migration plan M8c): the sections in their fixed order.
import { Component, useEffect, useState, type ReactNode } from "react";
import { MetadataSection } from "./panels/metadata";
import { AchievementsSection } from "./panels/achievements";
import { ActivitySection } from "./panels/activity";
import { CommunitySection } from "./panels/community";
import { RulesSection } from "./panels/rules";
import { RevisionSection } from "./panels/audit";
import { SyncProgressBar } from "./sync-progress";

class ExtensionErrorBoundary extends Component<{ id: string; children: ReactNode }, { hasError: boolean; error?: Error }> {
    constructor(props: any) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }
    override componentDidCatch(error: Error, info: any) {
        console.warn(`[steam-cartridges] Extension settings panel '${this.props.id}' crashed:`, error, info);
    }
    override render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: "12px", margin: "8px 0", background: "rgba(255, 0, 0, 0.1)", border: "1px solid rgba(255, 0, 0, 0.3)", borderRadius: "4px" }}>
                    <div style={{ color: "#ff8888", fontWeight: "bold" }}>Failed to render settings for extension: {this.props.id}</div>
                    <div style={{ color: "#aaaaaa", fontSize: "12px", marginTop: "4px" }}>{this.state.error?.message}</div>
                </div>
            );
        }
        return this.props.children;
    }
}

export function SettingsPanel() {
    const [, tick] = useState(0);

    // Periodic refresh so live collections, shortcuts, and extension panels remain synced
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 3000);
        return () => clearInterval(t);
    }, []);

    const extPanels = ((window as any).SteamCartridges?.getSettingsPanels?.() ?? []) as Array<{
        id: string;
        title: string;
        order?: number;
        render: () => any;
    }>;
    const prePanels = extPanels.filter((p) => (p.order ?? 50) < 40);
    const postPanels = extPanels.filter((p) => (p.order ?? 50) >= 40);

    return (
        <div style={{ paddingBottom: "70px", position: "relative" }}>
            <MetadataSection />
            <AchievementsSection />
            {prePanels.map((p) => (
                <ExtensionErrorBoundary key={p.id} id={p.id}>
                    {p.render()}
                </ExtensionErrorBoundary>
            ))}
            <ActivitySection />
            <CommunitySection />
            {postPanels.map((p) => (
                <ExtensionErrorBoundary key={p.id} id={p.id}>
                    {p.render()}
                </ExtensionErrorBoundary>
            ))}
            <RulesSection />
            <RevisionSection />
            <SyncProgressBar />
        </div>
    );
}
