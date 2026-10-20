// Game Data editor: the left column (ADR-0076): a text filter, "Only games with issues", and every non-Steam shortcut
// as a row with its issue count. A game that no longer matches the filter (fixed, renamed) leaves the list.
import { DialogButton } from "@steambrew/client";
import { ActionRow, BLOCK_GAP, Card, TextRows, ToggleRow } from "../components";
import type { LibraryIssues } from "./library-issues";
import { ISSUE_TINT_BORDER } from "./styles";

export function GamePicker({
    library,
    filter,
    onFilter,
    issuesOnly,
    onIssuesOnly,
    appid,
    onPick,
}: {
    library: LibraryIssues;
    filter: string;
    onFilter: (text: string) => void;
    issuesOnly: boolean;
    onIssuesOnly: (on: boolean) => void;
    appid: number | undefined;
    onPick: (appid: number) => void;
}) {
    const needle = filter.trim().toLowerCase();
    const shown = library.games.filter(
        (g) =>
            (!needle || g.name.toLowerCase().includes(needle)) &&
            // A game fixed while chosen leaves the list at once (the user's call); it stays open on the right.
            (!issuesOnly || library.issuesOf(g.appid).length > 0),
    );

    return (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
            <div style={{ padding: `${BLOCK_GAP}px ${BLOCK_GAP}px ${BLOCK_GAP}px` }}>
                <Card>
                    <TextRows label="Games" description={`${shown.length} of ${library.games.length} shown; type to filter by name`} value={filter} onChange={onFilter} />
                    <ToggleRow
                        label="Only games with issues"
                        description={`${library.stats.issues} game${library.stats.issues === 1 ? "" : "s"} miss Game Info, controller support or achievements`}
                        value={issuesOnly}
                        onChange={onIssuesOnly}
                    />
                    {library.loading && <ActionRow message="Reading your library..." />}
                </Card>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: `0 ${BLOCK_GAP}px ${BLOCK_GAP}px`, display: "flex", flexDirection: "column", gap: 4 }}>
                {shown.map((g) => {
                    const n = library.issuesOf(g.appid).length;
                    const chosen = g.appid === appid;
                    return (
                        <DialogButton
                            key={g.appid}
                            onClick={() => onPick(g.appid)}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 8,
                                width: "100%",
                                minWidth: 0,
                                padding: "6px 10px",
                                textAlign: "left",
                                background: chosen ? "rgba(26, 159, 255, 0.35)" : undefined,
                                borderLeft: n > 0 ? `3px solid ${ISSUE_TINT_BORDER}` : "3px solid transparent",
                            }}
                        >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                            {n > 0 && (
                                <span
                                    title={`${n} issue(s)`}
                                    style={{ flexShrink: 0, minWidth: 20, padding: "0 6px", borderRadius: 10, background: ISSUE_TINT_BORDER, color: "#fff", fontSize: 12, textAlign: "center" }}
                                >
                                    {n}
                                </span>
                            )}
                        </DialogButton>
                    );
                })}
            </div>
        </div>
    );
}
