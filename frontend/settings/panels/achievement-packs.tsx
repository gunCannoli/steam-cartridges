// Settings: Achievement packs (ADR-0081). The packs that ship with the plugin and those in the user's folder, which
// games use them, the files that are not packs and why; Import (Steam's file dialog) and Reload. A change refreshes the games the packs match at once (a forced
// ingest of those games), so nothing waits for a restart.
import { useEffect, useState } from "react";
import { DialogButton, Field, PanelSection } from "@steambrew/client";
import { asList } from "../../kernel/lists";
import { backend, type AchievementPackInfo, type AchievementPacksState } from "../../ports/backend";
import { usePanelContext } from "../context";
import { ActionRow, Blocks, BUTTON_STYLE, ButtonRow, ItemRow } from "../components";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function AchievementPacksSection() {
    const ctx = usePanelContext();
    const [state, setState] = useState<AchievementPacksState | null>(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    /** A picked file whose pack id is already in the folder: waiting for Replace or Cancel. */
    const [replacing, setReplacing] = useState<{ path: string; id: string } | null>(null);

    useEffect(() => {
        backend.achievementPacksList().then(setState).catch(() => {});
    }, []);

    /** After a reload or an import: show the new list, then refresh the games the packs match. */
    const settle = async (res: AchievementPacksState) => {
        setState(res);
        const matched = asList<number>(res.matched);
        const none = asList<number>(res.marked_none);
        if (matched.length > 0) {
            setMessage(`Looking up achievements for ${plural(matched.length, "game")}...`);
            await ctx.ingest.start({ forceAll: true, onlyAppids: matched });
        }
        let msg = matched.length > 0 ? `✓ Achievements looked up again for ${plural(matched.length, "game")}.` : "✓ Packs read. No shortcut uses one yet.";
        if (none.length > 0) {
            msg += ` ${plural(none.length, "game")} marked as having no achievements: use Retry achievement detection in its Cartridge page.`;
        }
        setMessage(msg);
    };

    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        try {
            await work();
        } catch (e) {
            setMessage(`Failed: ${String((e as Error)?.message ?? e)}`);
        } finally {
            setBusy(false);
        }
    };

    const reload = () =>
        run(async () => {
            setMessage("Reading the packs folder...");
            const res = await backend.achievementPacksReload();
            if (res.error) return setMessage(res.error);
            await settle(res);
        });

    const importFile = (path: string, replace: boolean) =>
        run(async () => {
            setMessage("Checking the pack...");
            const res = await backend.achievementPacksImport(path, replace);
            if (res.exists) {
                setReplacing({ path, id: res.id ?? "" });
                return setMessage(`A pack named "${res.id}" is already in the folder. Replace it?`);
            }
            setReplacing(null);
            if (res.error) return setMessage(`Not imported: ${res.error}`);
            await settle(res);
        });

    const pick = () =>
        run(async () => {
            const path = await ctx.files.pickJson("Import an achievement pack");
            if (path) await importFile(path, false);
        });

    const packs = state ? asList<AchievementPackInfo>(state.packs) : [];
    const problems = state ? asList<{ name: string; file: string; errors: unknown }>(state.problems) : [];
    const nameOf = (appid: number) => ctx.routing.shortcutName(appid);

    return (
        <PanelSection title="Achievement packs">
            <Blocks>
                <ItemRow>
                    <Field
                        label="Packs"
                        description="A pack gives a game achievements from one short file, for ports and fan projects no other source knows. Packs marked Included come with Steam Cartridges and work as they are; add your own (.json) to the folder below, or import one. A pack of yours with an included pack's name replaces it."
                        bottomSeparator="none"
                    />
                </ItemRow>
                {packs.map((p) => {
                    const games = asList<number>(p.games);
                    const skipped = asList<{ appid: number; chosen?: string }>(p.not_chosen);
                    const used = games.length > 0
                        ? `Used by ${games.map(nameOf).join(", ")}`
                        : skipped.length > 0
                          ? `Not used: ${skipped[0]?.chosen ?? "another pack"} is more complete`
                          : "No shortcut starts this game";
                    const origin = p.bundled ? "Included · " : p.replaces_bundled ? "Yours, replaces the included pack · " : "";
                    return (
                        <ItemRow key={p.id}>
                            <Field label={p.id} description={`${origin}${plural(p.count, "achievement")} · ${used}`} />
                        </ItemRow>
                    );
                })}
                {problems.map((p) => (
                    <ItemRow key={p.file}>
                        <Field
                            label={<span style={{ color: "#eb4b4b" }}>{p.name}</span>}
                            description={`Not a pack: ${asList<string>(p.errors).join("; ")}`}
                        />
                    </ItemRow>
                ))}
                {state && packs.length === 0 && problems.length === 0 && (
                    <ItemRow>
                        <Field label="No packs yet" description="Steam Cartridges reads every .json file in the folder below." />
                    </ItemRow>
                )}
                {state?.folder && (
                    <ItemRow>
                        <Field label="Your packs folder" description={state.folder} />
                    </ItemRow>
                )}
                {ctx.files.canPick() && (
                    <ButtonRow
                        label="Import a pack"
                        description="Choose a pack file; it is checked, then copied into the folder"
                        buttonLabel="Import..."
                        disabled={busy}
                        onClick={pick}
                    />
                )}
                <ButtonRow
                    label="Reload"
                    description="Read the folder again after adding or editing a pack or its icons"
                    buttonLabel="Reload"
                    disabled={busy}
                    onClick={reload}
                />
                {(message || replacing) && (
                    <ActionRow message={message}>
                        {replacing && (
                            <>
                                <DialogButton disabled={busy} onClick={() => importFile(replacing.path, true)} style={BUTTON_STYLE}>
                                    Replace
                                </DialogButton>
                                <DialogButton
                                    disabled={busy}
                                    onClick={() => {
                                        setReplacing(null);
                                        setMessage("");
                                    }}
                                    style={BUTTON_STYLE}
                                >
                                    Cancel
                                </DialogButton>
                            </>
                        )}
                    </ActionRow>
                )}
            </Blocks>
        </PanelSection>
    );
}
