// Game Data editor (features plan F1; its own window as big as the screen, and issues, ADR-0076): the games on the left,
// the chosen game's data on the right. Opened by Library Analytics through ctx.dialog (Steam's popup window: the
// settings window is too narrow for it). A game with issues has its missing pieces tinted; "Ignore issues", "No achievements" and the links fix or
// clear them without leaving the editor. Reads the app only through usePanelContext(); nothing here writes to Steam.
import { useEffect, useRef, useState } from "react";
import { Field } from "@steambrew/client";
import { setSetting, useSetting } from "../settings";
import { ActionRow, BLOCK_GAP, Blocks, ButtonRow, Card, ItemRow } from "../components";
import { usePanelContext, type EditorSnapshot } from "../context";
import { diff, draftOf, validate, type MetadataDraft } from "../../domain/metadata-edit";
import { ISSUE_LABELS } from "../../domain/game-issues";
import { GamePicker } from "./game-picker";
import { ControllerCard, DetailsCard, PlayersCard } from "./metadata-form";
import { SteamLink } from "./steam-link";
import { IgdbLink } from "./igdb-link";
import { ScreenscraperLink } from "./screenscraper-link";
import { AchievementsCard } from "./achievements-card";
import { useLibraryIssues } from "./library-issues";
import { tint, type RunAction } from "./styles";
import { Missing } from "./missing";

export function GameDataEditor({ issuesOnly: startIssuesOnly = false }: { issuesOnly?: boolean; closeModal?: () => void }) {
    const ctx = usePanelContext();
    const editor = ctx.editor;
    const library = useLibraryIssues();
    const [ignoredMap] = useSetting("ignoredIssues");
    const [filter, setFilter] = useState("");
    const [issuesOnly, setIssuesOnly] = useState(startIssuesOnly);
    const [appid, setAppid] = useState<number | undefined>();
    const [snapshot, setSnapshot] = useState<EditorSnapshot | undefined>();
    const [draft, setDraft] = useState<MetadataDraft | undefined>();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error: boolean; progress?: boolean; from?: string } | undefined>();
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

    // Start on a game: from "Fix issues" the first one with issues (once the issues are known), else the first one.
    const started = useRef(false);
    useEffect(() => {
        if (started.current || appid !== undefined) return;
        const first = startIssuesOnly ? library.games.find((g) => library.issuesOf(g.appid).length > 0) : library.games[0];
        if (first) {
            started.current = true;
            pick(first.appid);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [library.stats.issues, library.games.length, startIssuesOnly]);

    /** Runs one action: `progress` (with Steam's spinner) in the card `from` while it runs, then `done` or the error
     *  there; then reloads the game and the issues so the form shows what was stored. */
    const run: RunAction = (work, done, progress, from) => {
        if (appid === undefined) return;
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
    const issues = appid === undefined ? [] : library.issuesOf(appid);
    const missing = new Set(issues);
    const ignored = appid !== undefined && library.ignored(appid);
    const waiting = appid !== undefined && library.waiting(appid);

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

    return (
        <div style={{ display: "flex", height: "calc(100vh - 16px)", minHeight: 560, background: "#1b2838", color: "#dcdedf" }}>
            <div style={{ width: 380, flexShrink: 0, borderRight: "1px solid rgba(255, 255, 255, 0.08)", minHeight: 0 }}>
                <GamePicker library={library} filter={filter} onFilter={setFilter} issuesOnly={issuesOnly} onIssuesOnly={setIssuesOnly} appid={appid} onPick={pick} />
            </div>
            <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: BLOCK_GAP }}>
                {/* Loading (Steam's spinner, as the web searches): the library before a game is chosen, then the game. */}
                {(appid === undefined || !snapshot) && (
                    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
                        <Card>
                            <ActionRow
                                message={appid === undefined ? "Reading your library..." : `Loading ${library.games.find((g) => g.appid === appid)?.name ?? "the game"}...`}
                            />
                        </Card>
                    </div>
                )}
                {appid !== undefined && snapshot && (
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
                            {snapshot && draft && (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(480px, 1fr))", gap: BLOCK_GAP, alignItems: "start" }}>
                                    {column([
                                        <DetailsCard
                                            key="details"
                                            draft={draft}
                                            onChange={setDraft}
                                            errors={errors}
                                            dirty={dirty}
                                            custom={snapshot.custom}
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
                        </Blocks>
                    </div>
                )}
            </div>
        </div>
    );
}
