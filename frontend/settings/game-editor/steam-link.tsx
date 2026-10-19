// Game Data editor: the Steam link block (features plan F1). A manual link replaces the old
// "reject this suggestion" button: linking clears the game's suggestions, and "never suggest again" is a choice on Unlink.
import { useState } from "react";
import { DialogButton, Field, TextField } from "@steambrew/client";
import { usePanelContext, type EditorSnapshot } from "../context";
import type { StoreCandidate } from "../../ports/backend";
import { ActionRow, Blocks, BUTTON_STYLE, ButtonRow, CARD_BACKGROUND, ItemRow } from "../components";

export function SteamLink({ snapshot, busy, run }: { snapshot: EditorSnapshot; busy: boolean; run: (work: () => Promise<{ error?: string } | void>, done: string) => void }) {
    const editor = usePanelContext().editor;
    const [term, setTerm] = useState("");
    const [results, setResults] = useState<StoreCandidate[] | undefined>();
    const [searchError, setSearchError] = useState<string | undefined>();

    async function search() {
        setSearchError(undefined);
        const res = await editor.search(term);
        setResults(res.candidates);
        if (res.error) setSearchError(res.error);
    }

    return (
        <Blocks>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                <ItemRow>
                    <Field
                        label="Steam link"
                        description={
                            snapshot.link
                                ? `Linked to ${snapshot.link.name || "app"} (${snapshot.link.steam_appid}, ${snapshot.link.source})`
                                : "Not linked to a Steam game."
                        }
                        bottomSeparator="none"
                    />
                </ItemRow>
                {snapshot.link && (
                    <>
                        <ButtonRow
                            label="Unlink"
                            description="Allow title-based matching again"
                            buttonLabel="Unlink"
                            disabled={busy}
                            onClick={() => run(() => editor.unlink(snapshot.appid, false), "Unlinked.")}
                        />
                        <ButtonRow
                            label="Unlink for good"
                            description="Unlink and ignore this Steam game"
                            buttonLabel="Unlink"
                            disabled={busy}
                            onClick={() => run(() => editor.unlink(snapshot.appid, true), "Unlinked; this game will not be suggested again.")}
                        />
                    </>
                )}
                {snapshot.custom && snapshot.link && (
                    <ItemRow>
                        <Field label="Manual edit kept" description="Manual edit preserved. Revert to show Steam store data." bottomSeparator="none" />
                    </ItemRow>
                )}
            </div>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                <ItemRow trailing>
                    <TextField label="Search Steam games" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} />
                </ItemRow>
                <ButtonRow label="Search" description="Search Steam store by title" buttonLabel="Search" disabled={busy || term.trim().length < 2} onClick={() => void search()} />
                {searchError && <ActionRow message={`Search failed: ${searchError}`} />}
                {results && results.length === 0 && !searchError && (
                    <ItemRow>
                        <Field label="No Steam games found" bottomSeparator="none" />
                    </ItemRow>
                )}
                {results?.map((c) => (
                    <ItemRow key={c.steam_appid}>
                        <Field label={c.name} description={`Steam app ${c.steam_appid}`}>
                            <DialogButton
                                style={BUTTON_STYLE}
                                disabled={busy || snapshot.link?.steam_appid === c.steam_appid}
                                onClick={() => run(() => editor.link(snapshot.appid, c.steam_appid, c.name), `Linked to ${c.name}.`)}
                            >
                                Link
                            </DialogButton>
                        </Field>
                    </ItemRow>
                ))}
            </div>
        </Blocks>
    );
}
