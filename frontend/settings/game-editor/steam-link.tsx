// Game Data editor: the Steam link card (features plan F1). Search Steam and link the same game: it then gets Steam's own
// Game Info, artwork and achievement list. A manual link replaces the old "reject this suggestion" button: linking clears
// the game's suggestions, and "never suggest again" is a choice on Unlink. Layout: docs/plugins.md guardrail 18.
import { useState } from "react";
import { DialogButton, Field } from "@steambrew/client";
import { usePanelContext, type EditorSnapshot } from "../context";
import type { StoreCandidate } from "../../ports/backend";
import { ActionRow, BUTTON_STYLE, ButtonRow, Card, ItemRow, TextRows } from "../components";
import type { RunAction } from "./styles";

export function SteamLink({ snapshot, busy, run, status }: { snapshot: EditorSnapshot; busy: boolean; run: RunAction; status?: string }) {
    const editor = usePanelContext().editor;
    const [term, setTerm] = useState("");
    const [results, setResults] = useState<StoreCandidate[] | undefined>();
    const [searchError, setSearchError] = useState<string | undefined>();
    const [searching, setSearching] = useState(false);

    async function search() {
        setSearchError(undefined);
        setResults(undefined);
        setSearching(true);
        try {
            const res = await editor.search(term);
            setResults(res.candidates);
            if (res.error) setSearchError(res.error);
        } finally {
            setSearching(false);
        }
    }

    return (
        <Card>
            <ItemRow>
                <Field
                    label="Steam"
                    description={
                        snapshot.link
                            ? `Linked to ${snapshot.link.name || "app"} (${snapshot.link.steam_appid}, ${snapshot.link.source})${snapshot.custom ? ". Your own Game Info edit is kept: Revert shows Steam's." : ""}`
                            : "Not linked to a Steam game."
                    }
                    bottomSeparator="none"
                />
            </ItemRow>
            {snapshot.link && (
                <>
                    <ButtonRow label="Unlink" description="Lets the title match again" buttonLabel="Unlink" disabled={busy} onClick={() => run(() => editor.unlink(snapshot.appid, false), "Unlinked.", "Unlinking...", "steam")} />
                    <ButtonRow
                        label="Unlink for good"
                        description="Unlinks and never suggests this Steam game again"
                        buttonLabel="Unlink"
                        disabled={busy}
                        onClick={() => run(() => editor.unlink(snapshot.appid, true), "Unlinked; this game will not be suggested again.", "Unlinking...", "steam")}
                    />
                </>
            )}
            <TextRows label="Search Steam" description="By title; Enter searches" value={term} onChange={setTerm} onKeyDown={(e) => e.key === "Enter" && void search()} />
            <ButtonRow label="Search" description="Lists Steam's games with this title" buttonLabel={searching ? "Searching..." : "Search"} disabled={busy || searching || term.trim().length < 2} onClick={() => void search()} />
            {searching && <ActionRow message={`Searching Steam...`} />}
            {searchError && <ActionRow message={`Search failed: ${searchError}`} />}
            {results && results.length === 0 && !searchError && <ActionRow message="No Steam game has this title." />}
            {results?.map((c) => (
                <ItemRow key={c.steam_appid}>
                    <Field label={c.name} description={`Steam app ${c.steam_appid}`}>
                        <DialogButton
                            style={BUTTON_STYLE}
                            disabled={busy || snapshot.link?.steam_appid === c.steam_appid}
                            onClick={() => run(() => editor.link(snapshot.appid, c.steam_appid, c.name), `Linked to ${c.name}.`, `Linking to ${c.name}...`, "steam")}
                        >
                            Link
                        </DialogButton>
                    </Field>
                </ItemRow>
            ))}
            {status && <ActionRow message={status} />}
        </Card>
    );
}
