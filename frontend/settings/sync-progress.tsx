// Settings: the sticky sync progress bar and its hook (migration plan M8c).
import { useEffect, useState } from "react";
import { usePanelContext } from "./context";
import type { SyncProgress } from "../kernel/record";

export function useSyncProgress(): SyncProgress {
    const ctx = usePanelContext();
    const [progress, setProgress] = useState(() => ctx.ingest.progress());
    useEffect(() => ctx.ingest.onProgress(setProgress), [ctx]);
    return progress;
}

// ===========================================================================
// Main SettingsPanel Export
// ===========================================================================

export function SyncProgressBar() {
    const progress = useSyncProgress();

    if (!progress.isSyncing && progress.phase !== "complete") {
        return null;
    }

    const percent = Math.min(
        100,
        Math.round((progress.current / Math.max(1, progress.total)) * 100),
    );

    return (
        <div
            style={{
                position: "sticky",
                bottom: 0,
                left: 0,
                right: 0,
                background:
                    progress.phase === "complete"
                        ? "rgba(16, 34, 24, 0.96)"
                        : "rgba(16, 24, 34, 0.96)",
                backdropFilter: "blur(8px)",
                borderTop:
                    progress.phase === "complete"
                        ? "1px solid rgba(164, 208, 7, 0.4)"
                        : "1px solid rgba(102, 192, 244, 0.3)",
                padding: "10px 14px",
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
                gap: "5px",
                marginTop: "16px",
                borderRadius: "4px",
                boxShadow: "0 -4px 16px rgba(0, 0, 0, 0.4)",
            }}
        >
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                }}
            >
                <span
                    style={{
                        fontWeight: 600,
                        fontSize: "12px",
                        color:
                            progress.phase === "complete"
                                ? "#a4d007"
                                : "#66c0f4",
                    }}
                >
                    {progress.phase === "complete"
                        ? `✓ Scrape & mirror complete (${progress.total} games)`
                        : `🔄 Scraping & Mirroring: ${progress.current} / ${progress.total} games (${percent}%)`}
                </span>
                {progress.isSyncing && progress.currentGame ? (
                    <span
                        style={{
                            color: "#8ba5b7",
                            fontSize: "11px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {progress.currentGame}
                    </span>
                ) : null}
            </div>
            {progress.isSyncing && (
                <div
                    style={{
                        width: "100%",
                        height: "6px",
                        background: "rgba(255, 255, 255, 0.1)",
                        borderRadius: "3px",
                        overflow: "hidden",
                    }}
                >
                    <div
                        style={{
                            width: `${percent}%`,
                            height: "100%",
                            background:
                                "linear-gradient(90deg, #1a9fff, #66c0f4)",
                            transition: "width 0.25s ease-out",
                        }}
                    />
                </div>
            )}
        </div>
    );
}
