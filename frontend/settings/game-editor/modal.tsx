// Game Data editor (features plan F1; its own window as big as the screen, and issues, ADR-0076): the games on the left,
// the chosen game's data on the right (game-form.tsx, also the body of a game's Properties > Cartridge page, ADR-0080).
// Opened by Library Analytics through ctx.dialog (Steam's popup window: the settings window is too narrow for it). A game
// with issues has its missing pieces tinted; "Ignore issues", "No achievements" and the links fix or clear them without
// leaving the editor. Reads the app only through usePanelContext(); nothing here writes to Steam.
import { useEffect, useRef, useState } from "react";
import { ActionRow, BLOCK_GAP, Card } from "../components";
import { GamePicker } from "./game-picker";
import { GameForm } from "./game-form";
import { useLibraryIssues } from "./library-issues";

export function GameDataEditor({ issuesOnly: startIssuesOnly = false }: { issuesOnly?: boolean; closeModal?: () => void }) {
    const library = useLibraryIssues();
    const [filter, setFilter] = useState("");
    const [issuesOnly, setIssuesOnly] = useState(startIssuesOnly);
    const [appid, setAppid] = useState<number | undefined>();

    // Start on a game: from "Fix issues" the first one with issues (once the issues are known), else the first one.
    const started = useRef(false);
    useEffect(() => {
        if (started.current || appid !== undefined) return;
        const first = startIssuesOnly ? library.games.find((g) => library.issuesOf(g.appid).length > 0) : library.games[0];
        if (first) {
            started.current = true;
            setAppid(first.appid);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [library.stats.issues, library.games.length, startIssuesOnly]);

    return (
        <div style={{ display: "flex", height: "calc(100vh - 16px)", minHeight: 560, background: "#1b2838", color: "#dcdedf" }}>
            <div style={{ width: 380, flexShrink: 0, borderRight: "1px solid rgba(255, 255, 255, 0.08)", minHeight: 0 }}>
                <GamePicker library={library} filter={filter} onFilter={setFilter} issuesOnly={issuesOnly} onIssuesOnly={setIssuesOnly} appid={appid} onPick={setAppid} />
            </div>
            <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: BLOCK_GAP }}>
                {/* Loading (Steam's spinner, as the web searches): the library before a game is chosen; the form shows its own. */}
                {appid === undefined ? (
                    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
                        <Card>
                            <ActionRow message="Reading your library..." />
                        </Card>
                    </div>
                ) : (
                    <GameForm key={appid} appid={appid} library={library} />
                )}
            </div>
        </div>
    );
}
