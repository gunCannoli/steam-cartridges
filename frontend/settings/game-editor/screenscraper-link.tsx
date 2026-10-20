// Game Data editor: the ScreenScraper link card (ADR-0077, ADR-0079). Enter the game's ScreenScraper id (or its
// screenscraper.fr page address, …gameid=1234), search it, then save its game data: its Game Info comes from
// ScreenScraper (the database of console and arcade games), kept as the user's own edit. Needs a ScreenScraper account
// (Metadata > Add service). The card itself: id-link.tsx.
import { usePanelContext, type EditorSnapshot } from "../context";
import { IdLinkCard } from "./id-link";
import type { RunAction } from "./styles";

/** A bare positive integer, or the id in a screenscraper.fr game page address (`gameid=1234`), else undefined. */
function ssId(input: string): number | undefined {
    const cleaned = input.trim();
    const fromUrl = cleaned.match(/gameid=(\d+)/i)?.[1];
    const num = parseInt(fromUrl ?? cleaned, 10);
    return !isNaN(num) && num > 0 && (fromUrl !== undefined || String(num) === cleaned) ? num : undefined;
}

export function ScreenscraperLink({ snapshot, busy, run, status }: { snapshot: EditorSnapshot; busy: boolean; run: RunAction; status?: string }) {
    const editor = usePanelContext().editor;
    return (
        <IdLinkCard
            source="ScreenScraper"
            cardId="screenscraper"
            statusLine={
                snapshot.metadata.ss_id
                    ? `Game Info from ScreenScraper game #${snapshot.metadata.ss_id}${snapshot.metadata.matched_title ? ` (${snapshot.metadata.matched_title})` : ""}`
                    : "For console and arcade games: their Game Info from ScreenScraper."
            }
            idLabel="ScreenScraper game id"
            idDescription="Or the game page's address (…gameid=1234); Enter searches it"
            parseId={ssId}
            preview={(id) => editor.previewScreenscraper(snapshot.appid, id)}
            link={(id) => editor.linkScreenscraper(snapshot.appid, id)}
            busy={busy}
            run={run}
            status={status}
        />
    );
}
