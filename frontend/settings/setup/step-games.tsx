// Library Setup step 4 (plan § 7.3): every non-Steam game on the left, the chosen one's question on the right. The list
// is read at once (LibraryScan, offline); "Detect" looks the games up one by one (lookups only, nothing stored but what is
// proposed). Each game is answered by the user, one at a time, inline: Yes / No on a proposal, a manual link (platform and
// the Game Data editor's links) after No or when nothing fits, then an achievement source or "No achievements". There is
// no bulk validate (decision 6). A Yes or a link fetches that game. Reads the app only through usePanelContext().
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogButton, Dropdown, Field } from "@steambrew/client";
import { ActionRow, BLOCK_GAP, Blocks, Card, CONTROL_GAP, FullWidthRows, ItemRow, BUTTON_STYLE, SettingsModal, Select } from "../components";
import { usePanelContext } from "../context";
import { backend } from "../../ports/backend";
import { GameForm } from "../game-editor/game-form";
import { useLibraryIssues, type LibraryIssues } from "../game-editor/library-issues";
import {
    askOf,
    CERTAINTY_ICON,
    CERTAINTY_LABEL,
    CERTAINTY_ORDER,
    certaintyCounts,
    certaintyOf,
    compareNames,
    defaultFilter,
    matchesFilter,
    matchesQuery,
    inferredPlatform,
    gameFacts,
    proposalLines,
    SETUP_FILTERS,
    statusLabel,
    type CertaintyLevel,
    type SetupFilter,
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

/** Formats estimated remaining time into a concise human-readable suffix. */
function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const s = Math.round(seconds);
    if (s < 5) return "";
    if (s < 60) return ` (~${s}s remaining)`;
    const m = Math.floor(s / 60);
    const remSec = s % 60;
    return ` (~${m}m ${remSec}s remaining)`;
}

/** `autoDetect`: Refresh library (plan § 7.5) looks up every game that was never answered as soon as the list is read. */
export function GamesStep({
    autoDetect = false,
    scope,
    excluded = 0,
    onPending,
    gateOnFind = false,
    initialFilter,
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
    initialFilter?: SetupFilter;
}) {
    const ctx = usePanelContext();
    const library = useLibraryIssues();
    const [rows, setRows] = useState<SetupGame[] | undefined>();
    const [searched, setSearched] = useState(false);
    const [platforms, setPlatforms] = useState<SetupPlatform[]>([]);
    const [listError, setListError] = useState<string | undefined>();
    const [filter, setFilter] = useState<SetupFilter>(initialFilter ?? "uncertain");
    const [query, setQuery] = useState("");
    const [appid, setAppid] = useState<number | undefined>();
    const [notes, setNotes] = useState<Notes>({});
    const [confirming, setConfirming] = useState(false);
    const [bulkMsg, setBulkMsg] = useState<string | undefined>();
    const [sweep, setSweep] = useState<{ current: number; total: number; name: string; startTime: number } | undefined>();
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
                const initial = initialFilter ?? defaultFilter(games);
                setFilter(initial);
                const first = sorted.find((g) => matchesFilter(g, initial, library.inGroup));
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

    async function detect(id: number, forcedPlatform?: string): Promise<"proposed" | "link" | "no-sources" | "error"> {
        note(id, "Looking the game up...");
        try {
            const row = await ctx.setup.detect(id, forcedPlatform);
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
            const issues = (row.source_issues as string[] | undefined) ?? [];
            if (issues.length > 0) {
                // A source that failed is not a "no match": say so and what to do, and count it in the sweep's log line.
                note(id, `⚠ ${issues.join(" ")}`);
                backend.logEvent("setup", `game ${id}: ${issues.length} source(s) did not answer`);
            } else note(id, undefined);
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
        if (todo.length === 0) return;
        const tally = { proposed: 0, link: 0, nosources: 0, errors: 0 };
        const startTime = Date.now();
        try {
            setSweep({ current: 0, total: todo.length, name: todo[0]?.name ?? "", startTime });
            const updatedRows = await ctx.setup.detectAll(
                todo.map((g) => g.appid),
                (done, total, name) => {
                    if (!closed.current) {
                        setSweep({ current: done, total, name: name ?? "", startTime });
                    }
                },
                (chunkRows) => {
                    if (closed.current) return;
                    for (const row of chunkRows) {
                        if (row.error) tally.errors++;
                        else if (row.status === "proposed") tally.proposed++;
                        else if (row.no_sources) tally.nosources++;
                        else tally.link++;
                    }
                    const chunkMap = new Map(chunkRows.map((r) => [r.appid, r]));
                    setRows((prior) => prior?.map((g) => chunkMap.get(g.appid) ?? g));
                },
            );
            if (!closed.current && updatedRows.length > 0) {
                const updatedMap = new Map(updatedRows.map((r) => [r.appid, r]));
                setRows((prior) => prior?.map((g) => updatedMap.get(g.appid) ?? g));
            }
        } catch (e) {
            backend.logEvent("setup", `Find matches failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        } finally {
            setSweep(undefined);
            setSearched(true);
            if (todo.length > 0)
                backend.logEvent(
                    "setup",
                    `Find matches: ${todo.length} looked up, ${tally.proposed} proposed, ${tally.link} need a link, ${tally.nosources} no sources, ${tally.errors} errors`,
                );
        }
    }

    /** Confirm every proposal in the list at once (reversing decision 6): chunked calls validate them (one call per ten games: Millennium drops the caller after 30 s), one run fetches them, then the list is re-read. */
    async function confirmAll(): Promise<void> {
        if (proposed.length === 0 || confirming || sweep) return;
        setConfirming(true);
        setBulkMsg(`Confirming 0 of ${proposed.length}...`);
        const confirmStartTime = Date.now();
        let fetchStartTime: number | null = null;
        try {
            const res = await ctx.setup.validateAll(
                proposed.map((r) => r.appid),
                (done, tot, phase, gameName) => {
                    const now = Date.now();
                    if (phase === "fetching") {
                        if (!fetchStartTime) fetchStartTime = now;
                        const elapsed = (now - fetchStartTime) / 1000;
                        const eta = done > 0 && tot > done ? formatEta((tot - done) / (done / elapsed)) : "";
                        setBulkMsg(`Fetching ${done} of ${tot}${eta}${gameName ? `: ${gameName}` : ""}...`);
                    } else {
                        const elapsed = (now - confirmStartTime) / 1000;
                        const eta = done > 0 && tot > done ? formatEta((tot - done) / (done / elapsed)) : "";
                        setBulkMsg(`Confirming ${done} of ${tot}${eta}...`);
                    }
                },
            );
            for (const [id, err] of Object.entries(res.failed ?? {})) note(Number(id), String(err));
            const failedN = Object.keys(res.failed ?? {}).length;
            const summary = `confirmed ${res.confirmed.length} games${failedN > 0 ? `, ${failedN} failed` : ""}${res.fetchError ? `, fetch failed: ${res.fetchError.slice(0, 100)}` : ""}`;
            backend.logEvent("setup", summary);
            setBulkMsg(
                res.fetchError
                    ? `⚠ Confirmed ${res.confirmed.length} game${res.confirmed.length === 1 ? "" : "s"}, but fetching failed: ${res.fetchError}`
                    : `✓ Confirmed ${res.confirmed.length} game${res.confirmed.length === 1 ? "" : "s"}.`,
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

    async function refreshRows(_id?: number): Promise<void> {
        try {
            const res = await ctx.setup.scan();
            if (res.games) setRows(res.games);
        } catch {}
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
                const order = visible.filter((r) => matchesFilter(r, filter, library.inGroup));
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
    const shown = visible.filter((r) => matchesFilter(r, filter, library.inGroup) && matchesQuery(r, query)).sort(compareNames);
    const waiting = visible.filter((r) => askOf(r) === "detect").length;
    const needsYou = visible.filter((r) => matchesFilter(r, "needs-you")).length;
    const proposed = visible.filter((r) => askOf(r) === "answer");
    const counts = useMemo(() => certaintyCounts(visible), [visible]);
    const alreadyDone = visible.filter((r) => askOf(r) === "done" || askOf(r) === "skipped").length;
    const countSummary = alreadyDone > 0 ? ` (${alreadyDone} already set up)` : "";
    const [conflictModalOpen, setConflictModalOpen] = useState(false);
    const [modalPlatforms, setModalPlatforms] = useState<Record<number, string>>({});
    const [resolvingConflict, setResolvingConflict] = useState(false);
    const conflictGames = useMemo(() => visible.filter((r) => r.status === "conflict"), [visible]);
    // The picked game, or the list's first when the pick is not shown (a scope that arrived after the scan).
    const chosen = shown.find((r) => r.appid === appid) ?? shown[0] ?? visibleSorted[0];
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
                        label={`Games to set up: ${needsYou}${countSummary}`}
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
                            description="Confirms every proposed match at once across confidence levels (certain to uncertain), then fetches them. Games with nothing proposed still need you."
                            disabled={confirming || !!sweep}
                            bottomSeparator="none"
                        >
                            <DialogButton disabled={confirming || !!sweep} onClick={() => void confirmAll()} style={BUTTON_STYLE}>
                                {confirming ? "Confirming..." : `Confirm ${proposed.length} game${proposed.length === 1 ? "" : "s"}`}
                            </DialogButton>
                        </Field>
                    </ItemRow>
                )}
                {visible.length > 0 && CERTAINTY_ORDER.some((l) => counts[l] > 0) && (
                    <ItemRow>
                        <CertaintyStrip
                            counts={counts}
                            onPickLevel={(l) => {
                                if (l === "conflict") {
                                    setConflictModalOpen(true);
                                    if (conflictGames[0]) setAppid(conflictGames[0].appid);
                                } else if (l === "none") {
                                    setFilter("no-match");
                                    const firstNone = visible.find((r) => matchesFilter(r, "no-match"));
                                    if (firstNone) setAppid(firstNone.appid);
                                } else {
                                    const filterMap: Record<string, SetupFilter> = {
                                        verified: "certain",
                                        high: "likely",
                                        medium: "possible",
                                        low: "uncertain",
                                    };
                                    const target = filterMap[l] ?? "all";
                                    setFilter(target);
                                    const first = visible.find((r) => matchesFilter(r, target));
                                    if (first) setAppid(first.appid);
                                }
                            }}
                        />
                    </ItemRow>
                )}
                {bulkMsg && <ActionRow message={bulkMsg} />}
                {rows === undefined && !listError && <ActionRow message="Reading your library..." />}
                {sweep && (() => {
                    const elapsed = (Date.now() - sweep.startTime) / 1000;
                    const eta = sweep.current > 0 && sweep.total > sweep.current ? formatEta((sweep.total - sweep.current) / (sweep.current / elapsed)) : "";
                    return <ActionRow message={`Looking up ${sweep.current} of ${sweep.total}${eta}: ${sweep.name}...`} />;
                })()}
                {listError && <ActionRow message={listError} />}
                {rows !== undefined && visible.length === 0 && excluded > 0 && (
                    <ActionRow message="⚠ No game is in scope of your rules: add a rule in step 3 (Rules) to set games up." />
                )}
            </Card>
            <div
                style={{ display: "flex", flex: 1, minHeight: 0, gap: BLOCK_GAP, ...(locked || confirming ? { opacity: 0.4, pointerEvents: "none" } : {}) }}
                inert={locked || confirming}
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
                    <Card style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#dcdedf" }}>
                            Filter by name or collection
                        </div>
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            style={{
                                width: "100%",
                                boxSizing: "border-box",
                                background: "rgba(0, 0, 0, 0.25)",
                                border: "1px solid rgba(255, 255, 255, 0.15)",
                                borderRadius: 3,
                                color: "#fff",
                                padding: "6px 8px",
                                fontSize: 13,
                                outline: "none",
                            }}
                        />
                        <Dropdown
                            rgOptions={SETUP_FILTERS.map((f) => {
                                const count = visible.filter((r) => matchesFilter(r, f.id, library.inGroup)).length;
                                return {
                                    data: f.id,
                                    label: `${f.icon ? `${f.icon} ` : ""}${f.label} (${count})`,
                                    count,
                                };
                            }).filter((opt) => opt.data === "all" || opt.count > 0)}
                            selectedOption={filter}
                            onChange={(o) => setFilter(o.data as SetupFilter)}
                            contextMenuPositionOptions={{ bMatchWidth: true }}
                        />
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
                            onDetectPlatform={(p) => void detect(chosen.appid, p)}
                            onAnswer={(a, progress) => void answer(chosen, a, progress)}
                            onUpdated={() => void refreshRows(chosen.appid)}
                        />
                    )}
                </div>
            </div>
            {conflictModalOpen && conflictGames.length > 0 && (
                <SettingsModal
                    title={
                        conflictGames.length === 1 && conflictGames[0]
                            ? `Platform Conflict: ${conflictGames[0].name}`
                            : `Resolve Platform Conflicts (${conflictGames.length})`
                    }
                    isOpen={true}
                    onClose={() => setConflictModalOpen(false)}
                    width="620px"
                >
                    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0" }}>
                        <div style={{ fontSize: 13, color: "#dcdedf", lineHeight: "1.5" }}>
                            {conflictGames.length === 1
                                ? "This game cannot be automatically looked up because its platform signals conflict with each other. Select the correct platform below to resolve the conflict and look up matches."
                                : "These games have conflicting platform signals. Choose their platform to resolve the conflict."}
                        </div>
                        {conflictGames.map((cg) => {
                            const cgSignals = Array.isArray(cg.signals) ? (cg.signals as string[]) : [];
                            const candidates = Array.isArray(cg.candidates) ? (cg.candidates as string[]) : [];
                            const curPlatform =
                                modalPlatforms[cg.appid] ??
                                cg.choice?.platform ??
                                (candidates[0] ||
                                    inferredPlatform(cg) ||
                                    (cgSignals.some((s) => s.toLowerCase().includes("windows"))
                                        ? "pc"
                                        : platforms.find((p) => p.id !== "steam" && p.id !== "pc")?.id ?? "pc"));
                            return (
                                <Card key={cg.appid}>
                                    <ItemRow>
                                        <Field
                                            label={cg.name}
                                            description="Its platform signals disagree:"
                                            bottomSeparator="none"
                                        />
                                    </ItemRow>
                                    {cgSignals.length > 0 && (
                                        <div style={{ padding: "0 16px 8px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
                                            {cgSignals.map((sig, i) => (
                                                <div key={i} style={{ fontSize: 12, color: "#8f98a0" }}>
                                                    • {sig}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {cg.collections && cg.collections.length > 0 && (
                                        <div style={{ padding: "0 16px 8px 16px", fontSize: 12, color: "#8f98a0" }}>
                                            Collections: <span style={{ color: "#ffffff" }}>{cg.collections.join(", ")}</span>
                                        </div>
                                    )}
                                    {candidates.length > 0 && (
                                        <div style={{ padding: "4px 16px 8px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                                            <div style={{ fontSize: 12, color: "#8f98a0" }}>Suggested candidates:</div>
                                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                                {candidates.map((candId) => {
                                                    const pInfo = platforms.find((p) => p.id === candId);
                                                    const isSelected = curPlatform === candId;
                                                    return (
                                                        <button
                                                            key={candId}
                                                            type="button"
                                                            onClick={() => setModalPlatforms((mp) => ({ ...mp, [cg.appid]: candId }))}
                                                            style={{
                                                                padding: "6px 12px",
                                                                borderRadius: "3px",
                                                                border: isSelected ? "1px solid #1a9fff" : "1px solid rgba(255, 255, 255, 0.15)",
                                                                background: isSelected ? "rgba(26, 159, 255, 0.25)" : "rgba(255, 255, 255, 0.05)",
                                                                color: isSelected ? "#ffffff" : "#dcdedf",
                                                                fontWeight: isSelected ? 600 : 400,
                                                                fontSize: 12,
                                                                cursor: "pointer",
                                                                transition: "all 0.15s ease",
                                                            }}
                                                        >
                                                            {isSelected ? "✓ " : ""}{pInfo?.name ?? candId.toUpperCase()}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                    <FullWidthRows label="Select Platform" description="Which platform database should look this game up?">
                                        <Select
                                            options={platforms.map((p) => ({
                                                value: p.id,
                                                label: p.name,
                                            }))}
                                            value={curPlatform}
                                            onChange={(val) => setModalPlatforms((mp) => ({ ...mp, [cg.appid]: val }))}
                                        />
                                    </FullWidthRows>
                                    <ActionRow>
                                        <DialogButton
                                            disabled={resolvingConflict}
                                            onClick={async () => {
                                                setResolvingConflict(true);
                                                try {
                                                    await detect(cg.appid, curPlatform);
                                                    setAppid(cg.appid);
                                                    if (conflictGames.length <= 1) {
                                                        setConflictModalOpen(false);
                                                    }
                                                } finally {
                                                    setResolvingConflict(false);
                                                }
                                            }}
                                            style={BUTTON_STYLE}
                                        >
                                            {resolvingConflict ? "Looking up..." : "Resolve & Look up"}
                                        </DialogButton>
                                    </ActionRow>
                                </Card>
                            );
                        })}
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: CONTROL_GAP, paddingTop: 12, borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
                            <DialogButton onClick={() => setConflictModalOpen(false)} style={BUTTON_STYLE}>
                                Close
                            </DialogButton>
                        </div>
                    </div>
                </SettingsModal>
            )}
        </div>
    );
}

/** The scale's colours (review-queue plan § 3). The bars and the word say it too, never the colour alone. */
const LEVEL_COLOR: Record<CertaintyLevel, string> = {
    verified: "#3fbf6f",
    high: "#2bb3a3",
    medium: "#e8d44d",
    low: "#e5a00d",
    conflict: "#e5a00d",
    none: "#eb4b4b",
    confirmed: "#1a9fff",
    pending: "#9aa3ad",
    skipped: "#6b7280",
};

function CertaintyPill({
    level,
    count,
    onClick,
}: {
    level: CertaintyLevel;
    count: number;
    onClick?: () => void;
}) {
    const [hover, setHover] = useState(false);
    return (
        <span
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title={
                level === "conflict"
                    ? "Platform signals disagree (e.g. collection vs executable). Click to resolve."
                    : level === "none"
                    ? "Nothing found to propose. Click to inspect."
                    : `Filter games to ${CERTAINTY_LABEL[level]}`
            }
            style={{
                color: LEVEL_COLOR[level],
                whiteSpace: "nowrap",
                cursor: onClick ? "pointer" : "default",
                background: onClick && hover ? "rgba(255, 255, 255, 0.12)" : onClick ? "rgba(255, 255, 255, 0.05)" : undefined,
                padding: onClick ? "2px 8px" : undefined,
                borderRadius: onClick ? "4px" : undefined,
                border: onClick ? "1px solid rgba(255, 255, 255, 0.1)" : undefined,
                boxShadow: onClick && hover ? "0 0 6px rgba(255, 255, 255, 0.15)" : undefined,
                transition: "all 0.15s ease",
                userSelect: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
            }}
        >
            <span style={{ letterSpacing: -1 }}>{CERTAINTY_ICON[level]}</span>
            <span>
                {count} {level === "conflict" ? (count === 1 ? "conflict" : "conflicts") : CERTAINTY_LABEL[level]}
            </span>
        </span>
    );
}

/** How many games sit at each level of certainty (a level with none is left out). */
function CertaintyStrip({
    counts,
    onPickLevel,
}: {
    counts: Record<CertaintyLevel, number>;
    onPickLevel?: (level: CertaintyLevel) => void;
}) {
    const shown = CERTAINTY_ORDER.filter((l) => counts[l] > 0);
    return (
        <div
            style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 14px",
                alignItems: "center",
                padding: "6px 16px",
                fontSize: 13,
            }}
            title="How sure the plugin is about each match"
        >
            {shown.length === 0 && <span style={{ opacity: 0.6 }}>Nothing to be sure about yet</span>}
            {shown.map((l) => (
                <CertaintyPill
                    key={l}
                    level={l}
                    count={counts[l]}
                    onClick={onPickLevel ? () => onPickLevel(l) : undefined}
                />
            ))}
        </div>
    );
}

/** One line, one height for every game: its certainty mark and its name; the colour and the bars say how sure the plugin is. */
function GameRow({ row, chosen, onPick }: { row: SetupGame; chosen: boolean; onPick: () => void }) {
    const c = certaintyOf(row);
    const color = LEVEL_COLOR[c.level];
    return (
        <DialogButton
            onClick={onPick}
            title={`${CERTAINTY_LABEL[c.level]}: ${c.reasons.join(". ")}`}
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
            <span style={{ display: "inline-block", width: 42, letterSpacing: -1, fontSize: 11 }}>{CERTAINTY_ICON[c.level]}</span>
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
    onDetect: _onDetect,
    onDetectPlatform,
    onAnswer,
    onUpdated,
}: {
    row: SetupGame;
    platforms: SetupPlatform[];
    library: LibraryIssues;
    note: string | undefined;
    onDetect: () => void;
    onDetectPlatform?: (platform: string) => void;
    onAnswer: (a: SetupAnswer, progress: string) => void;
    onUpdated?: () => void;
}) {
    const ask = askOf(row);
    const certainty = certaintyOf(row);
    const busy = note?.endsWith("...") ?? false;
    const candidates = Array.isArray(row.candidates) ? row.candidates : [];
    const [platform, setPlatform] = useState<string>(
        row.choice?.platform ??
        row.platform ??
        candidates[0] ??
        inferredPlatform(row) ??
        (platforms.find((p) => p.id !== "steam" && p.id !== "pc")?.id ?? "pc")
    );

    useEffect(() => {
        setPlatform(
            row.choice?.platform ??
            row.platform ??
            (Array.isArray(row.candidates) && row.candidates.length > 0 ? row.candidates[0] : null) ??
            inferredPlatform(row) ??
            (platforms.find((p) => p.id !== "steam" && p.id !== "pc")?.id ?? "pc")
        );
    }, [row.appid, row.platform, row.choice]);

    const signals = (row.signals as string[] | undefined) ?? [];
    const found = proposalLines(row.proposal);
    // A Steam-only proposal: Game Info, artwork and community come from Steam's own data, not from a fetch.
    const steamMirror = row.proposal?.steam_appid !== undefined && row.proposal?.igdb_id === undefined && row.proposal?.ss_id === undefined;
    const details = gameFacts(row);
    const header = [statusLabel(row), row.platform_name ?? inferredPlatform(row.proposal) ?? (ask === "detect" ? undefined : "platform unknown")].filter(Boolean).join(" · ");

    const question = (() => {
        switch (ask) {
            case "detect":
                return null;
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
            case "achievements":
                return <GameForm key="links" appid={row.appid} library={library} single onUpdated={onUpdated} />;
            case "link":
                // Two blocks (an array: Blocks spaces them; a fragment would be one block, the cards touching).
                return [
                    <Card key="question">
                        <ItemRow>
                            <Field
                                label={row.status === "conflict" ? "Platform signals conflict" : "Link it by hand"}
                                description={
                                    row.status === "conflict"
                                        ? "Its signals disagree on the platform (e.g. collection vs executable path). Pick the platform below, then Resolve & Find match."
                                        : "Nothing to propose, or the proposal was refused. Pick the platform, link the game in the cards below, then Validate."
                                }
                                bottomSeparator="none"
                            />
                        </ItemRow>
                        {platforms.length > 0 && (
                            <FullWidthRows label="Platform" description="The platform this copy of the game runs on">
                                {candidates.length > 0 && (
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                                        {candidates.map((candId) => {
                                            const pInfo = platforms.find((p) => p.id === candId);
                                            const isSelected = platform === candId;
                                            return (
                                                <button
                                                    key={candId}
                                                    type="button"
                                                    onClick={() => setPlatform(candId)}
                                                    style={{
                                                        padding: "4px 10px",
                                                        borderRadius: "3px",
                                                        border: isSelected ? "1px solid #1a9fff" : "1px solid rgba(255, 255, 255, 0.15)",
                                                        background: isSelected ? "rgba(26, 159, 255, 0.25)" : "rgba(255, 255, 255, 0.05)",
                                                        color: isSelected ? "#ffffff" : "#dcdedf",
                                                        fontWeight: isSelected ? 600 : 400,
                                                        fontSize: 12,
                                                        cursor: "pointer",
                                                        transition: "all 0.15s ease",
                                                    }}
                                                >
                                                    {isSelected ? "✓ " : ""}{pInfo?.name ?? candId.toUpperCase()}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                <Select
                                    options={platforms.map((p) => ({
                                        value: p.id,
                                        label: p.name,
                                    }))}
                                    value={platform}
                                    onChange={(val) => setPlatform(val)}
                                />
                            </FullWidthRows>
                        )}
                        <ActionRow message={note}>
                            {row.status === "conflict" && onDetectPlatform && (
                                <DialogButton
                                    disabled={busy}
                                    onClick={() => onDetectPlatform(platform)}
                                    style={BUTTON_STYLE}
                                >
                                    Resolve & Find match
                                </DialogButton>
                            )}
                            <DialogButton
                                disabled={busy}
                                onClick={() =>
                                    onAnswer(
                                        {
                                            linked: true,
                                            platform,
                                        },
                                        "Validating and fetching the game...",
                                    )
                                }
                                style={BUTTON_STYLE}
                            >
                                Validate
                            </DialogButton>
                            <DialogButton disabled={busy} onClick={() => onAnswer({ skip: true }, "Skipping...")} style={BUTTON_STYLE}>
                                Skip
                            </DialogButton>
                        </ActionRow>
                    </Card>,
                    <GameForm key="links" appid={row.appid} library={library} single onUpdated={onUpdated} />,
                ];
            default: {
                if (ask === "skipped") {
                    return (
                        <Card>
                            <ItemRow>
                                <Field
                                    label="Left alone"
                                    description="The plugin never fetches this game."
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
                }
                return <GameForm key="links" appid={row.appid} library={library} single onUpdated={onUpdated} />;
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
                {certainty.level !== "pending" && (
                    <ItemRow>
                        <Field
                            label={
                                <span style={{ color: LEVEL_COLOR[certainty.level] }}>
                                    <span style={{ letterSpacing: -1 }}>{CERTAINTY_ICON[certainty.level]}</span>{" "}
                                    {certainty.level === "confirmed" && ask === "achievements"
                                        ? "Confirmed · Achievements missing"
                                        : CERTAINTY_LABEL[certainty.level]}
                                </span>
                            }
                            description={
                                certainty.level === "confirmed"
                                    ? row.status === "existing"
                                        ? "Set up before Library Setup"
                                        : undefined
                                    : certainty.reasons.join(" · ")
                            }
                            bottomSeparator="none"
                        />
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
