// Game Data editor: the IGDB link card. Enter the game's IGDB id, search it, then save its game data: its Game Info
// comes from IGDB, kept as the user's own edit (ADR-0077, ADR-0079). The card itself: id-link.tsx.
import { usePanelContext, type EditorSnapshot } from "../context";
import { IdLinkCard } from "./id-link";
import type { RunAction } from "./styles";

/** A bare positive integer, else undefined. */
function igdbId(input: string): number | undefined {
    const cleaned = input.trim();
    const num = parseInt(cleaned, 10);
    return !isNaN(num) && num > 0 && String(num) === cleaned ? num : undefined;
}

export function IgdbLink({ snapshot, busy, run, status }: { snapshot: EditorSnapshot; busy: boolean; run: RunAction; status?: string }) {
    const editor = usePanelContext().editor;
    return (
        <IdLinkCard
            source="IGDB"
            cardId="igdb"
            statusLine={
                snapshot.metadata.igdb_id
                    ? `Linked to IGDB game #${snapshot.metadata.igdb_id}${snapshot.metadata.matched_title ? ` (${snapshot.metadata.matched_title})` : ""}`
                    : "Not linked to an IGDB game."
            }
            idLabel="IGDB game id"
            idDescription="The id on the game's igdb.com page; Enter searches it"
            parseId={igdbId}
            preview={(id) => editor.previewIgdb(snapshot.appid, id)}
            link={(id) => editor.linkIgdb(snapshot.appid, id)}
            busy={busy}
            run={run}
            status={status}
        />
    );
}
