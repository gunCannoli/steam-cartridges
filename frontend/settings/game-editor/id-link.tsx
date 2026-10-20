// Game Data editor: a link-by-id card (IGDB, ScreenScraper; ADR-0079). The user enters a game id and searches it, sees
// the game it is (title, platforms, year, developers), then saves its game data as their own edit.
// Layout: docs/plugins.md guardrail 18 (the id on its own rows, each action a ButtonRow, progress with Steam's spinner).
import { useState } from "react";
import { Field } from "@steambrew/client";
import type { LinkPreview } from "../context";
import { ActionRow, ButtonRow, Card, ItemRow, TextRows } from "../components";
import type { RunAction } from "./styles";

export function IdLinkCard({
    source,
    cardId,
    statusLine,
    idLabel,
    idDescription,
    parseId,
    preview,
    link,
    busy,
    run,
    status,
}: {
    /** "IGDB", "ScreenScraper". */
    source: string;
    /** The card's id for run()'s status routing. */
    cardId: string;
    /** What the game is linked to now. */
    statusLine: string;
    idLabel: string;
    idDescription: string;
    parseId: (input: string) => number | undefined;
    preview: (id: number) => Promise<{ game?: LinkPreview; error?: string }>;
    link: (id: number) => Promise<{ error?: string } | void>;
    busy: boolean;
    run: RunAction;
    status?: string;
}) {
    const [input, setInput] = useState("");
    const [looking, setLooking] = useState(false);
    const [found, setFound] = useState<{ id: number; game: LinkPreview } | undefined>();
    const [lookError, setLookError] = useState<string | undefined>();
    const id = parseId(input);

    async function lookUp() {
        if (!id) return;
        setFound(undefined);
        setLookError(undefined);
        setLooking(true);
        try {
            const res = await preview(id);
            if (res.game) setFound({ id, game: res.game });
            else setLookError(res.error ?? `No ${source} game has this id.`);
        } catch (e) {
            setLookError(String((e as Error)?.message ?? e));
        } finally {
            setLooking(false);
        }
    }

    return (
        <Card>
            <ItemRow>
                <Field label={source} description={statusLine} bottomSeparator="none" />
            </ItemRow>
            <TextRows
                label={idLabel}
                description={idDescription}
                value={input}
                onChange={(v) => {
                    setInput(v);
                    // A changed id is another game: what was found is not it any more.
                    setFound(undefined);
                    setLookError(undefined);
                }}
                onKeyDown={(e) => e.key === "Enter" && void lookUp()}
            />
            <ButtonRow
                label="Search"
                description={`Checks the id on ${source} and shows its game; nothing is saved yet`}
                buttonLabel={looking ? "Searching..." : "Search"}
                disabled={busy || looking || !id}
                onClick={() => void lookUp()}
            />
            {looking && <ActionRow message={`Searching ${source} for game #${id}...`} />}
            {lookError && <ActionRow message={lookError} />}
            {found && (
                <>
                    <ItemRow>
                        <Field label={found.game.title} description={[found.game.details, `${source} #${found.id}`].filter(Boolean).join(" · ")} bottomSeparator="none" />
                    </ItemRow>
                    <ButtonRow
                        label="Save game data"
                        description={`Saves this game's Game Info from ${source} as your own edit; Revert undoes it`}
                        buttonLabel="Save"
                        disabled={busy}
                        onClick={() => {
                            const chosen = found;
                            run(
                                async () => {
                                    const res = await link(chosen.id);
                                    if (!res || !res.error) {
                                        setFound(undefined);
                                        setInput("");
                                    }
                                    return res;
                                },
                                `Saved ${chosen.game.title}'s game data from ${source}.`,
                                `Saving ${chosen.game.title}'s game data...`,
                                cardId,
                            );
                        }}
                    />
                    <ButtonRow label="Cancel" description="Nothing is saved" buttonLabel="Cancel" disabled={busy} onClick={() => setFound(undefined)} />
                </>
            )}
            {status && <ActionRow message={status} />}
        </Card>
    );
}
