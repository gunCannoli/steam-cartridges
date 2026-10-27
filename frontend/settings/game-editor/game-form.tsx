// One game's editing view, shared by the Game Data editor window (modal.tsx, the chosen game on the right) and a game's
// Properties > Cartridge page (CartridgeBody, surfaces/properties; ADR-0080): the header card (what is missing, Fetch now,
// Ignore issues), the details form, controller support, players, achievements and the Steam, IGDB and ScreenScraper
// links. Reads the app only through usePanelContext(); nothing here writes to Steam.
import { useEffect, useRef, useState } from "react";
import { Field } from "@steambrew/client";
import { setSetting, useSetting } from "../settings";
import { ActionRow, BLOCK_GAP, Blocks, ButtonRow, Card, ItemRow } from "../components";
import { usePanelContext, type EditorSnapshot } from "../context";
import { diff, draftOf, validate, type MetadataDraft } from "../../domain/metadata-edit";
import { ISSUE_LABELS } from "../../domain/game-issues";
import { ControllerCard, DetailsCard, PlayersCard } from "./metadata-form";
import { SteamLink } from "./steam-link";
import { IgdbLink } from "./igdb-link";
import { ScreenscraperLink } from "./screenscraper-link";
import { AchievementsCard } from "./achievements-card";
import { useLibraryIssues, type LibraryIssues } from "./library-issues";
import { tint, type RunAction } from "./styles";
import { Missing } from "./missing";

/** The game `appid`: loads its snapshot, edits a draft, runs every action. Mount it with `key={appid}` to switch game. */
export function GameForm({ appid, library, single = false }: { appid: number; library: LibraryIssues; single?: boolean }) {
    const ctx = usePanelContext();
    const editor = ctx.editor;
    const [ignoredMap] = useSetting("ignoredIssues");
    const [snapshot, setSnapshot] = useState<EditorSnapshot | undefined>();
    const [draft, setDraft] = useState<MetadataDraft | undefined>();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error: boolean; progress?: boolean; from?: string } | undefined>();
    const loadId = useRef(0);

    async function load(id: number) {
        const mine = ++loadId.current;
        const snap = await editor.load(id);
        if (mine !== loadId.current) return; // another load started meanwhile
        setSnapshot(snap);
        setDraft(draftOf(snap.metadata));
    }

    useEffect(() => {
        void load(appid).catch((e) => setMessage({ text: String(e?.message ?? e), error: true }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appid]);

    /** Runs one action: `progress` (with Steam's spinner) in the card `from` while it runs, then `done` or the error
     *  there; then reloads the game and the issues so the form shows what was stored. */
    const run: RunAction = (work, done, progress, from) => {
        const id = appid;
        setBusy(true);
        setMessage({ text: progress ?? "Working...", error: false, progress: true, from });
        work()
            .then(async (res) => {
                if (res && res.error) setMessage({ text: res.error, error: true, from });
                else setMessage({ text: done, error: false, from });
                await ctx.records.refreshAchievements?.(id);
                await library.refresh();
                await load(id);
            })
            .catch((e) => setMessage({ text: String(e?.message ?? e), error: true, from }))
            .finally(() => setBusy(false));
    };

    /** The status row of card `from` (the game's card when an action names none). */
    const statusFor = (from?: string): string | undefined =>
        message && message.from === from ? (message.error || message.progress ? message.text : `✓ ${message.text}`) : undefined;

    const setIgnored = (id: number, on: boolean) => {
        const next = { ...ignoredMap };
        if (on) next[String(id)] = true;
        else delete next[String(id)];
        void setSetting("ignoredIssues", next);
        setMessage({ text: on ? "Issues ignored: the game left the list." : "Issues shown again.", error: false });
    };

    const errors = draft ? validate(draft) : [];
    const dirty = snapshot && draft ? diff(snapshot.metadata, draft).length > 0 : false;
    const issues = library.issuesOf(appid);
    const missing = new Set(issues);
    const ignored = library.ignored(appid);
    const waiting = library.waiting(appid);

    const summary = ignored
        ? "Issues ignored: this game is not in the issues list."
        : waiting
          ? "Not looked up yet: the background sync has not reached it."
          : issues.length > 0
            ? `Missing: ${issues.map((k) => ISSUE_LABELS[k]).join(", ")}.`
            : "Nothing missing.";

    /** One column of cards, BLOCK_GAP apart (guardrail 18.4): each card is its own child of Blocks (a fragment would be one
     *  block, its cards touching). */
    const column = (cards: React.ReactNode[]) => (
        <div style={{ minWidth: 0 }}>
            <Blocks>{cards}</Blocks>
        </div>
    );
    const name = snapshot?.title ?? library.games.find((g) => g.appid === appid)?.name ?? String(appid);

    if (!snapshot) {
        return (
            <div style={{ maxWidth: 1600, margin: "0 auto" }}>
                <Card>
                    <ActionRow message={message?.error ? message.text : `Loading ${name}...`} />
                </Card>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: 1600, margin: "0 auto" }}>
            <Blocks>
                <Card style={tint(issues.length > 0)}>
                    <Missing on={issues.length > 0}>
                        <ItemRow>
                            <Field label={<span style={{ fontSize: 18 }}>{name}</span>} description={summary} bottomSeparator="none" />
                        </ItemRow>
                    </Missing>
                    <ButtonRow
                        label="Fetch now"
                        description="Looks the game up again in every source"
                        buttonLabel="Fetch now"
                        disabled={busy}
                        onClick={() => run(() => ctx.ingest.start({ forceAll: true, onlyAppids: [appid] }), "Looked up again.", "Looking the game up in every source...")}
                    />
                    <ButtonRow
                        label={ignored ? "Stop ignoring" : "Ignore issues"}
                        description={ignored ? "Puts the game back in the issues list" : "Takes the game off the issues list; nothing else changes"}
                        buttonLabel={ignored ? "Stop ignoring" : "Ignore"}
                        disabled={busy || (!ignored && issues.length === 0)}
                        onClick={() => setIgnored(appid, !ignored)}
                    />
                    {statusFor(undefined) && <ActionRow message={statusFor(undefined)} />}
                </Card>
                {draft && (
                    <div style={{ display: "grid", gridTemplateColumns: single ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(480px, 1fr))", gap: BLOCK_GAP, alignItems: "start" }}>
                        {column([
                            <DetailsCard
                                key="details"
                                draft={draft}
                                onChange={setDraft}
                                errors={errors}
                                dirty={dirty}
                                custom={snapshot.custom}
                                linked={snapshot.linked ? (snapshot.linked.source === "igdb" ? "IGDB" : "ScreenScraper") : undefined}
                                hasMetadata={snapshot.hasMetadata}
                                busy={busy}
                                onSave={() => run(() => editor.save(snapshot.appid, draft), "Saved.", "Saving...", "details")}
                                onRevert={() => run(() => editor.revert(snapshot.appid), "Reverted to fetched data.", "Fetching the game's data again...", "details")}
                                status={statusFor("details")}
                                missing={missing}
                            />,
                            <ControllerCard
                                key="controller"
                                appid={snapshot.appid}
                                missing={missing.has("controller")}
                                onNotice={(text) => {
                                    setMessage({ text, error: false });
                                    void library.refresh();
                                }}
                            />,
                            <PlayersCard key="players" draft={draft} onChange={setDraft} />,
                        ])}
                        {column([
                            // The game's achievements on top, then where its data comes from.
                            <AchievementsCard
                                key="achievements"
                                appid={snapshot.appid}
                                state={library.achievementsOf(snapshot.appid)}
                                waiting={waiting}
                                missing={missing.has("achievements")}
                                busy={busy}
                                run={run}
                                status={statusFor("achievements")}
                            />,
                            <SteamLink key="steam" snapshot={snapshot} busy={busy} run={run} status={statusFor("steam")} />,
                            <IgdbLink key="igdb" snapshot={snapshot} busy={busy} run={run} status={statusFor("igdb")} />,
                            <ScreenscraperLink key="screenscraper" snapshot={snapshot} busy={busy} run={run} status={statusFor("screenscraper")} />,
                        ])}
                    </div>
                )}
                <Card>
                    <ButtonRow
                        label="Delete metadata"
                        description="Deletes everything the plugin fetched or learned about this game: Game Info, achievements, the match you confirmed, downloaded media. It is asked again in Library Setup."
                        buttonLabel="Delete"
                        disabled={busy}
                        onClick={() =>
                            run(
                                () => editor.deleteMetadata(snapshot.appid).then(() => ({})),
                                "Metadata deleted. Restart Steam to refresh the pages already open.",
                                "Deleting the game's metadata...",
                                "delete",
                            )
                        }
                    />
                    {statusFor("delete") && <ActionRow message={statusFor("delete")} />}
                </Card>
            </Blocks>
        </div>
    );
}

/**
 * A game's Properties > Cartridge page body (ADR-0080): the same form as the editor window, on the page itself in one
 * column (the Properties window is narrow). Handed to
 * surfaces/properties by index.tsx as an opaque component (the surface never imports settings/).
 */
export function CartridgeBody({ appid }: { appid: number }) {
    const library = useLibraryIssues();
    return (
        <div style={{ padding: `0 ${BLOCK_GAP}px ${BLOCK_GAP}px 0`, minWidth: 0 }}>
            <GameForm key={appid} appid={appid} library={library} single />
        </div>
    );
}
