// Game Data editor popup (features plan F1): pick a shortcut, edit its metadata, manage its Steam link.
// Reads the app only through usePanelContext().editor; nothing here writes to Steam.
import { useRef, useState } from "react";
import { PanelSection } from "@steambrew/client";
import { ActionRow, Blocks, SettingsModal } from "../components";
import { usePanelContext, type EditorSnapshot } from "../context";
import { diff, draftOf, validate, type MetadataDraft } from "../../domain/metadata-edit";
import { GamePicker } from "./game-picker";
import { MetadataForm } from "./metadata-form";
import { SteamLink } from "./steam-link";
import { IgdbLink } from "./igdb-link";

export function GameDataEditor({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const editor = usePanelContext().editor;
    const [filter, setFilter] = useState("");
    const [appid, setAppid] = useState<number | undefined>();
    const [snapshot, setSnapshot] = useState<EditorSnapshot | undefined>();
    const [draft, setDraft] = useState<MetadataDraft | undefined>();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error: boolean } | undefined>();
    const loadId = useRef(0);

    async function load(id: number) {
        const mine = ++loadId.current;
        const snap = await editor.load(id);
        if (mine !== loadId.current) return; // the user picked another game meanwhile
        setSnapshot(snap);
        setDraft(draftOf(snap.metadata));
    }

    function pick(id: number) {
        setAppid(id);
        setSnapshot(undefined);
        setDraft(undefined);
        setMessage(undefined);
        void load(id).catch((e) => setMessage({ text: String(e?.message ?? e), error: true }));
    }

    /** Runs one editor action, then reloads the game so the form shows what was stored. */
    function run(work: () => Promise<{ error?: string } | void>, done: string) {
        if (appid === undefined) return;
        setBusy(true);
        setMessage(undefined);
        work()
            .then(async (res) => {
                if (res && res.error) setMessage({ text: res.error, error: true });
                else setMessage({ text: done, error: false });
                await load(appid);
            })
            .catch((e) => setMessage({ text: String(e?.message ?? e), error: true }))
            .finally(() => setBusy(false));
    }

    const errors = draft ? validate(draft) : [];
    const dirty = snapshot && draft ? diff(snapshot.metadata, draft).length > 0 : false;

    return (
        <SettingsModal title="Game Data" isOpen={isOpen} onClose={onClose} width="640px" maxHeight="85vh">
            <PanelSection>
                <Blocks>
                    <GamePicker filter={filter} onFilter={setFilter} appid={appid} onPick={pick} />
                    {message && <ActionRow message={message.error ? message.text : `✓ ${message.text}`} />}
                    {snapshot && draft && (
                        <MetadataForm
                            appid={snapshot.appid}
                            draft={draft}
                            onChange={setDraft}
                            errors={errors}
                            dirty={dirty}
                            custom={snapshot.custom}
                            hasMetadata={snapshot.hasMetadata}
                            busy={busy}
                            onSave={() => run(() => editor.save(snapshot.appid, draft), "Saved.")}
                            onRevert={() => run(() => editor.revert(snapshot.appid), "Reverted to fetched data.")}
                            onNotice={(text) => setMessage({ text, error: false })}
                        />
                    )}
                    {snapshot && draft && <IgdbLink snapshot={snapshot} busy={busy} run={run} />}
                    {snapshot && draft && <SteamLink snapshot={snapshot} busy={busy} run={run} />}
                </Blocks>
            </PanelSection>
        </SettingsModal>
    );
}
