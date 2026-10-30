// Library Setup step 4 (plan § 7.3): every non-Steam game on the left, the chosen one's question on the right. The list
// is read at once (LibraryScan, offline); "Detect" looks the games up one by one (lookups only, nothing stored but what is
// proposed). Each game is answered by the user, one at a time, inline: Yes / No on a proposal, a manual link (platform and
// the Game Data editor's links) after No or when nothing fits, then an achievement source or "No achievements". There is
// no bulk validate (decision 6). A Yes or a link fetches that game. Reads the app only through usePanelContext().
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogButton, Dropdown, Field } from "@steambrew/client";
import { ActionRow, BLOCK_GAP, Blocks, Card, CONTROL_GAP, FullWidthRows, ItemRow, TextRows, BUTTON_STYLE } from "../components";
import { usePanelContext } from "../context";
import { backend } from "../../ports/backend";
import { GameForm } from "../game-editor/game-form";
import { useLibraryIssues, type LibraryIssues } from "../game-editor/library-issues";
import {
    askOf,
    compareNames,
    matchesFilter,
    matchesQuery,
    inferredPlatform,
    gameFacts,
    proposalLines,
    SETUP_FILTERS,
    statusLabel,
    tierOf,
    type SetupFilter,
    type SetupTier,
} from "../../domain/library-setup";
import type { SetupAnswer, SetupGame, SetupPlatform } from "../../ports/backend";

/** The confirmation of each answer, in its card. */
const DONE: Record<string, string> = {
    yes: "Validated and fetched.",
    linked: "Validated and fetched.",
    no: "Proposal dropped: link the game by hand.",
    no_achievements: "No achievements: never asked again.",
    skip: "Skipped: the plugin leaves this game alone.",
    reset: "Answer forgotten: the game waits for you again.",
};

const answerKind = (a: SetupAnswer): string => Object.keys(a).find((k) => k in DONE) ?? "yes";

/** What a game's card shows under its question: progress ("...") , a success ("✓ ...") or an error. */
type Notes = Record<number, string>;

/** `autoDetect`: Refresh library (plan § 7.5) looks up every game that was never answered as soon as the list is read. */
export function GamesStep({
    autoDetect = false,
    scope,
    excluded = 0,
    onPending,
    gateOnFind = false,
}: {
    autoDetect?: boolean;
    /** The rules' in-scope games (the window's scope set); the list shows only these, the rest are counted in the header (plan phase 6). Undefined (Refresh library) shows every game. A set, not a predicate, so a late rules read re-filters the list instead of freezing the first render's answer. */
    scope?: ReadonlySet<number>;
    /** Games the scan read that are out of scope (the header's count). */
    excluded?: number;
    /** The games still waiting to be set up in what the list shows (for the onboarding log line). */
    onPending?: (pending: number) => void;
    /** Onboarding: the list waits (greyed out) until the matches were looked up, so the user answers with the proposals in front of them. */
    gateOnFind?: boolean;
}) {
    const ctx = usePanelContext();
    const library = useLibraryIssues();
    const [rows, setRows] = useState<SetupGame[] | undefined>();
    const [searched, setSearched] = useState(false);
    const [platforms, setPlatforms] = useState<SetupPlatform[]>([]);
    const [listError, setListError] = useState<string | undefined>();
    const [filter, setFilter] = useState<SetupFilter>("needs-you");
    const [query, setQuery] = useState("");
    const [appid, setAppid] = useState<number | undefined>();
    const [notes, setNotes] = useState<Notes>({});
    const [confirming, setConfirming] = useState(false);
    const [bulkMsg, setBulkMsg] = useState<string | undefined>();
    const [sweep, setSweep] = useState<{ current: number; total: number; name: string } | undefined>();
    const closed = useRef(false);
    const refreshed = useRef(new Set<number>());

    const note = (id: number, text: string | undefined) =>
        setNotes((n) => {
            const next = { ...n };
            if (text === undefined) delete next[id];
            else next[id] = text;
            return next;
        });
    const put = (row: SetupGame) => setRows((rs) => rs?.map((r) => (r.appid === row.appid ? row : r)));

    useEffect(() => {
        closed.current = false;
        ctx.setup
            .scan()
            .then((res) => {
                if (closed.current) return;
                // Raw rows: the scope filter is derived at render (a late rules read re-filters; a mount-time filter froze).
                setRows(res.games);
                setPlatforms(res.platforms);
                setListError(res.error);
                // The first game the list shows (it is sorted by name), not the first the scan returned.
                const games = scope ? res.games.filter((g) => scope.has(g.appid)) : res.games;
                const sorted = [...games].sort(compareNames);
                const first = sorted.find((g) => matchesFilter(g, "needs-you"));
                if (!first && games.length > 0) setFilter("all"); // nothing waits for the user: show every game, not an empty list
                setAppid((first ?? sorted[0])?.appid);
                if (autoDetect) void detectAll(games);
            })
            .catch((e) => {
                const msg = String(e?.message ?? e);
                backend.logEvent("setup", `games list scan failed: ${msg.slice(0, 120)}`);
                setListError(msg);
            });
        return () => {
            closed.current = true; // the window closed: a running Detect stops after its current game
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function detect(id: number): Promise<"proposed" | "link" | "no-sources" | "error"> {
        note(id, "Looking the game up...");
        try {
            const row = await ctx.setup.detect(id);
            if (row.error) {
                note(id, row.error);
                return "error";
            }
            if (row.no_sources) {
                put(row);
                note(id, "⚠ No source searched it: turn on a source in step 1 (Metadata), then Find matches again.");
                return "no-sources";
            }
            put(row);
            note(id, undefined);
            return askOf(row) === "answer" ? "proposed" : "link";
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            note(id, msg);
            backend.logEvent("setup", `detect ${id} failed: ${msg.slice(0, 120)}`);
            return "error";
        }
    }

    async function detectAll(list: SetupGame[] | undefined = visible): Promise<void> {
        const todo = (list ?? []).filter((r) => askOf(r) === "detect");
        const tally = { proposed: 0, link: 0, nosources: 0, errors: 0 };
        for (const [i, game] of todo.entries()) {
            if (closed.current) break;
            setSweep({ current: i + 1, total: todo.length, name: game.name });
            const out = await detect(game.appid);
            if (out === "proposed") tally.proposed++;
            else if (out === "link") tally.link++;
            else if (out === "no-sources") tally.nosources++;
            else tally.errors++;
        }
        setSweep(undefined);
        setSearched(true);
        if (todo.length > 0)
            backend.logEvent(
                "setup",
                `Find matches: ${todo.length} looked up, ${tally.proposed} proposed, ${tally.link} need a link, ${tally.nosources} no sources, ${tally.errors} errors`,
            );
    }

    /** Confirm every proposal in the list at once (reversing decision 6): chunked calls validate them (one call per ten games: Millennium drops the caller after 30 s), one run fetches them, then the list is re-read. */
    async function confirmAll(): Promise<void> {
        if (proposed.length === 0 || confirming || sweep) return;
        setConfirming(true);
        setBulkMsg(undefined);
        try {
            const total = proposed.length;
            const res = await ctx.setup.validateAll(
                proposed.map((r) => r.appid),
                (done) => setBulkMsg(`Confirming ${done} of ${total}...`),
            );
            for (const [id, err] of Object.entries(res.failed ?? {})) note(Number(id), String(err));
            const failedN = Object.keys(res.failed ?? {}).length;
            const summary = `confirmed ${res.confirmed.length} games${failedN > 0 ? `, ${failedN} failed` : ""}${res.fetchError ? `, fetch failed: ${res.fetchError.slice(0, 100)}` : ""}`;
            backend.logEvent("setup", summary);
            setBulkMsg(
                res.fetchError
                    ? `⚠ Confirmed ${res.confirmed.length} game${res.confirmed.length === 1 ? "" : "s"}, but fetching failed: ${res.fetchError}`
                    : `✓ Confirmed ${res.confirmed.length} game${res.confirmed.length === 1 ? "" : "s"}; fetching ${res.confirmed.length === 1 ? "it" : "them"} now.`,
            );
            const next = await ctx.setup.scan();
            if (!closed.current && !next.error) setRows(next.games);
            else if (next.error) setListError(next.error);
            await library.refresh();
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            backend.logEvent("setup", `confirm-all failed: ${msg.slice(0, 120)}`);
            setBulkMsg(msg);
        } finally {
            if (!closed.current) setConfirming(false);
        }
    }

    /** The user's answer; then the next game that needs them, in the list's order. */
    async function answer(row: SetupGame, a: SetupAnswer, progress: string): Promise<void> {
        note(row.appid, progress);
        try {
            const next = await ctx.setup.validate(row.appid, a);
            if (next.error) {
                note(row.appid, next.error);
                return;
            }
            put(next);
            const warnings = [...((next.warnings as string[] | undefined) ?? []), ...(next.fetchError ? [`Fetch failed: ${next.fetchError}`] : [])];
            note(row.appid, warnings.length > 0 ? warnings.join(" ") : `✓ ${DONE[answerKind(a)]}`);
            await library.refresh();
            // A warning (a failed fetch) keeps the game on screen so it can be read; otherwise a confirmed game is done and the list moves on.
            if (warnings.length === 0 && !matchesFilter(next, "needs-you")) {
                const order = visible.filter((r) => matchesFilter(r, filter));
                const at = order.findIndex((r) => r.appid === row.appid);
                const after = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].find(
                    (r) => r.appid !== row.appid && matchesFilter(r, "needs-you"),
                );
                setAppid(after?.appid); // the next game that needs the user, or none: a confirmed game is done here
            }
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            note(row.appid, msg);
            backend.logEvent("setup", `answer ${row.appid} failed: ${msg.slice(0, 120)}`);
        }
    }

    // What the list shows: the scope's games (derived each render, so a late rules read re-filters).
    const visible = useMemo(() => (scope ? (rows ?? []).filter((r) => scope.has(r.appid)) : (rows ?? [])), [rows, scope]);
    const visibleSorted = useMemo(() => [...visible].sort(compareNames), [visible]);
    const shown = visible.filter((r) => (matchesFilter(r, filter) && matchesQuery(r, query)) || r.appid === appid).sort(compareNames);
    const waiting = visible.filter((r) => askOf(r) === "detect").length;
    const needsYou = visible.filter((r) => matchesFilter(r, "needs-you")).length;
    const proposed = visible.filter((r) => askOf(r) === "answer");
    // The picked game, or the list's first when the pick is not shown (a scope that arrived after the scan).
    const chosen = visible.find((r) => r.appid === appid) ?? visibleSorted.find((r) => matchesFilter(r, filter)) ?? visibleSorted[0];
    // Onboarding: nothing to answer until the games were looked up (the list waits, greyed out).
    const locked = gateOnFind && waiting > 0 && !searched;
    useEffect(() => onPending?.(needsYou), [needsYou]); // eslint-disable-line react-hooks/exhaustive-deps

    // A proposal stored before the question showed details has none: look it up again once, so the user can see what it is.
    useEffect(() => {
        const p = chosen?.proposal;
        // A proposal stored before it carried the game's facts is looked up again once (the Steam details, IGDB,
        // ScreenScraper or the RetroAchievements set).
        const steamThin = p?.steam_appid !== undefined && p?.igdb_id === undefined && p?.ss_id === undefined && (p?.year === undefined || p?.developers === undefined);
        const otherThin =
            p !== undefined && p !== null && p.genres === undefined && p.developers === undefined && (p.igdb_id !== undefined || p.ss_id !== undefined || p.ra_game_id !== undefined);
        if (!chosen || askOf(chosen) !== "answer" || !p || (!steamThin && !otherThin)) return;
        if (refreshed.current.has(chosen.appid)) return;
        refreshed.current.add(chosen.appid);
        void detect(chosen.appid);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chosen?.appid, rows]);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                gap: BLOCK_GAP,
                minHeight: 0,
                height: "100%",
            }}
        >
            <Card>
                <ItemRow>
                    <Field
                        label={excluded > 0 ? `Games to set up: ${needsYou} (${excluded} out of scope)` : `Games to set up: ${needsYou}`}
                        description="Click Find matches to look every game up on your sources. Then confirm each proposed match below, or all at once; nothing is saved until you confirm."
                        disabled={!!sweep || waiting === 0}
                        bottomSeparator="none"
                    >
                        <DialogButton disabled={!!sweep || waiting === 0} onClick={() => void detectAll(visible)} style={BUTTON_STYLE}>
                            {sweep ? "Looking up..." : waiting > 0 ? `Find matches for ${waiting} game${waiting === 1 ? "" : "s"}` : "All looked up"}
                        </DialogButton>
                    </Field>
                </ItemRow>
                {proposed.length > 0 && (
                    <ItemRow>
                        <Field
                            label={`Confirm all proposed (${proposed.length})`}
                            description="Confirms every proposed match at once, then fetches the games. Games with nothing proposed still need you."
                            disabled={confirming || !!sweep}
                            bottomSeparator="none"
                        >
                            <DialogButton disabled={confirming || !!sweep} onClick={() => void confirmAll()} style={BUTTON_STYLE}>
                                {confirming ? "Confirming..." : `Confirm ${proposed.length} game${proposed.length === 1 ? "" : "s"}`}
                            </DialogButton>
                        </Field>
                    </ItemRow>
                )}
                {bulkMsg && <ActionRow message={bulkMsg} />}
                {rows === undefined && !listError && <ActionRow message="Reading your library..." />}
                {sweep && <ActionRow message={`Looking up ${sweep.current} of ${sweep.total}: ${sweep.name}...`} />}
                {listError && <ActionRow message={listError} />}
                {rows !== undefined && visible.length === 0 && excluded > 0 && (
                    <ActionRow message="⚠ No game is in scope of your rules: add a rule in step 3 (Rules) to set games up." />
                )}
            </Card>
            <div
                style={{ display: "flex", flex: 1, minHeight: 0, gap: BLOCK_GAP, ...(locked ? { opacity: 0.4, pointerEvents: "none" } : {}) }}
                inert={locked}
            >
                <div
                    style={{
                        width: 340,
                        flexShrink: 0,
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        gap: CONTROL_GAP,
                    }}
                >
                    <Card>
                        <FullWidthRows label="Show">
                            <Dropdown
                                rgOptions={SETUP_FILTERS.map((f) => ({
                                    data: f.id,
                                    label: `${f.label} (${visible.filter((r) => matchesFilter(r, f.id)).length})`,
                                }))}
                                selectedOption={filter}
                                onChange={(o) => setFilter(o.data as SetupFilter)}
                                contextMenuPositionOptions={{ bMatchWidth: true }}
                            />
                        </FullWidthRows>
                        <TextRows label="Filter by name or collection" value={query} onChange={setQuery} />
                    </Card>
                    <div
                        style={{
                            flex: 1,
                            minHeight: 0,
                            overflowY: "auto",
                            overflowX: "hidden",
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                        }}
                    >
                        {shown.map((r) => (
                            <GameRow
                                key={r.appid}
                                row={r}
                                chosen={r.appid === appid}
                                onPick={() => setAppid(r.appid)}
                            />
                        ))}
                    </div>
                </div>
                <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
                    {chosen && (
                        <GameCard
                            key={chosen.appid}
                            row={chosen}
                            platforms={platforms}
                            library={library}
                            note={notes[chosen.appid]}
                            onDetect={() => void detect(chosen.appid)}
                            onAnswer={(a, progress) => void answer(chosen, a, progress)}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

/** The list's colours: blue set up, yellow missing a little, amber missing more, red not detected, grey left alone. */
const TIER_COLOR: Record<SetupTier, string> = {
    ok: "#1a9fff",
    minor: "#e8d44d",
    more: "#e5a00d",
    none: "#eb4b4b",
    skipped: "#6b7280",
};

/** One line, one height for every game: its name; the colour says how far it is from set up. */
function GameRow({ row, chosen, onPick }: { row: SetupGame; chosen: boolean; onPick: () => void }) {
    const color = TIER_COLOR[tierOf(row)];
    return (
        <DialogButton
            onClick={onPick}
            title={row.name}
            style={{
                display: "block",
                flexShrink: 0,
                width: "100%",
                minWidth: 0,
                height: 34,
                padding: "0 10px",
                textAlign: "left",
                lineHeight: "34px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color,
                background: chosen ? "rgba(26, 159, 255, 0.35)" : undefined,
                borderLeft: `3px solid ${color}`,
            }}
        >
            {row.name}
        </DialogButton>
    );
}

/** One fact about the game: label and value at one size (the Field description's), the value wrapping beside its label. */
function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ display: "flex", gap: BLOCK_GAP, fontSize: 13, lineHeight: "18px" }}>
            <span style={{ width: 96, flexShrink: 0, opacity: 0.6 }}>{label}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{value}</span>
        </div>
    );
}

/** The chosen game: what the plugin found and the one question it asks now. */
function GameCard({
    row,
    platforms,
    library,
    note,
    onDetect,
    onAnswer,
}: {
    row: SetupGame;
    platforms: SetupPlatform[];
    library: LibraryIssues;
    note: string | undefined;
    onDetect: () => void;
    onAnswer: (a: SetupAnswer, progress: string) => void;
}) {
    const ask = askOf(row);
    const busy = note?.endsWith("...") ?? false;
    const [platform, setPlatform] = useState<string>(row.choice?.platform ?? row.platform ?? "steam");
    const signals = (row.signals as string[] | undefined) ?? [];
    const found = proposalLines(row.proposal);
    // A Steam-only proposal: Game Info, artwork and community come from Steam's own data, not from a fetch.
    const steamMirror = row.proposal?.steam_appid !== undefined && row.proposal?.igdb_id === undefined && row.proposal?.ss_id === undefined;
    const details = gameFacts(row);
    const header = [statusLabel(row), row.platform_name ?? inferredPlatform(row.proposal) ?? (ask === "detect" ? undefined : "platform unknown")].filter(Boolean).join(" · ");

    const question = (() => {
        switch (ask) {
            case "detect":
                return (
                    <Card>
                        <ItemRow>
                            <Field
                                label="Not looked up yet"
                                description="Find a match proposes a game for it. Nothing is saved until you confirm."
                                bottomSeparator="none"
                            />
                        </ItemRow>
                        <ActionRow message={note}>
                            <DialogButton disabled={busy} onClick={onDetect} style={BUTTON_STYLE}>
                                Find a match
                            </DialogButton>
                            <DialogButton disabled={busy} onClick={() => onAnswer({ skip: true }, "Skipping...")} style={BUTTON_STYLE}>
                                Skip
                            </DialogButton>
                        </ActionRow>
                    </Card>
                );
            case "answer":
                return (
                    <Card>
                        <ItemRow>
                            <Field
                                label={`Confirm below that this game is "${row.name}"`}
                                description={steamMirror && found.length > 0 ? `${found.join(" · ")} — Game Info, artwork and community come from Steam.` : found.join(" · ")}
                                bottomSeparator="none"
                            />
                        </ItemRow>

                        <ActionRow message={note}>
                            <DialogButton
                                disabled={busy}
                                onClick={() => onAnswer({ yes: true }, "Linking and fetching the game...")}
                                style={BUTTON_STYLE}
                            >
                                Yes
                            </DialogButton>
                            <DialogButton disabled={busy} onClick={() => onAnswer({ no: true }, "Dropping the proposal...")} style={BUTTON_STYLE}>
                                No
                            </DialogButton>
                            <DialogButton disabled={busy} onClick={() => onAnswer({ skip: true }, "Skipping...")} style={BUTTON_STYLE}>
                                Skip
                            </DialogButton>
                        </ActionRow>
                    </Card>
                );
            case "link":
            case "achievements":
                // Two blocks (an array: Blocks spaces them; a fragment would be one block, the cards touching).
                return [
                    <Card key="question">
                        <ItemRow>
                            <Field
                                label={ask === "link" ? "Link it by hand" : "No achievements found"}
                                description={
                                    ask === "link"
                                        ? row.status === "conflict"
                                            ? "Its signals disagree on the platform. Pick the platform, link the game in the cards below, then Validate."
                                            : "Nothing to propose, or the proposal was refused. Pick the platform, link the game in the cards below, then Validate."
                                        : "Choose an achievement source in the Achievements card below, or say the game has none: it is never asked again."
                                }
                                bottomSeparator="none"
                            />
                        </ItemRow>
                        {ask === "link" && platforms.length > 0 && (
                            <FullWidthRows label="Platform" description="The platform this copy of the game runs on">
                                <Dropdown
                                    rgOptions={platforms.map((p) => ({
                                        data: p.id,
                                        label: p.name,
                                    }))}
                                    selectedOption={platform}
                                    onChange={(o) => setPlatform(o.data as string)}
                                    contextMenuPositionOptions={{ bMatchWidth: true }}
                                />
                            </FullWidthRows>
                        )}
                        <ActionRow message={note}>
                            <DialogButton
                                disabled={busy}
                                onClick={() =>
                                    onAnswer(
                                        {
                                            linked: true,
                                            platform: ask === "link" ? platform : row.choice?.platform,
                                        },
                                        "Validating and fetching the game...",
                                    )
                                }
                                style={BUTTON_STYLE}
                            >
                                Validate
                            </DialogButton>
                            {ask === "achievements" && (
                                <DialogButton disabled={busy} onClick={() => onAnswer({ no_achievements: true }, "Saving...")} style={BUTTON_STYLE}>
                                    No achievements
                                </DialogButton>
                            )}
                            <DialogButton disabled={busy} onClick={() => onAnswer({ skip: true }, "Skipping...")} style={BUTTON_STYLE}>
                                Skip
                            </DialogButton>
                        </ActionRow>
                    </Card>,
                    <GameForm key="links" appid={row.appid} library={library} single />,
                ];
            default: {
                const card = (
                    <Card>
                        <ItemRow>
                            <Field
                                label={ask === "skipped" ? "Left alone" : "Validated"}
                                description={
                                    ask === "skipped"
                                        ? "The plugin never fetches this game."
                                        : row.status === "existing"
                                          ? "Set up before Library Setup: it keeps refreshing as before."
                                          : "The plugin fetches this game. Its details are in the Game Data editor."
                                }
                                bottomSeparator="none"
                            />
                        </ItemRow>
                        <ActionRow message={note}>
                            <DialogButton disabled={busy} onClick={() => onAnswer({ reset: true }, "Forgetting the answer...")} style={BUTTON_STYLE}>
                                Ask again
                            </DialogButton>
                        </ActionRow>
                    </Card>
                );
                return card;
            }
        }
    })();

    return (
        <Blocks>
            <Card>
                <ItemRow>
                    <Field label={<span style={{ fontSize: 18 }}>{row.name}</span>} description={header} bottomSeparator="none" />
                </ItemRow>
                {details.length > 0 && (
                    <div style={{ padding: "0 13px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                        {details.map(([label, value]) => (
                            <DetailRow key={label} label={label} value={value} />
                        ))}
                    </div>
                )}
                {signals.length > 0 && (
                    <ItemRow>
                        <Field label="Signals" description={signals.join(" · ")} bottomSeparator="none" />
                    </ItemRow>
                )}
                {found.length > 0 && ask !== "answer" && (
                    <ItemRow>
                        <Field label="Proposed" description={found.join(" · ")} bottomSeparator="none" />
                    </ItemRow>
                )}
            </Card>
            {question}
        </Blocks>
    );
}
