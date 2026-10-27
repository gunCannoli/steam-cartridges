// The library's issues, for Library Analytics and the Game Data editor (ADR-0076): one load of the stored records, one
// rule (domain/game-issues.ts). Moved from the Library Audit panel; reads the app through the panel context.
import { useCallback, useEffect, useRef, useState } from "react";
import { onSettingChange, setting, useSetting } from "../settings";
import { onLibraryChanged } from "../library-events";
import { backend } from "../../ports/backend";
import type { GameMetadata } from "../../kernel/record";
import { lookupStored } from "../../kernel/appid";
import { controllerFromPlatforms } from "../../domain/controller-platforms";
import { gameIssues, fetched, inGroup, type IssueKey, type LibraryGroup } from "../../domain/game-issues";
import { usePanelContext } from "../context";
import { useSyncProgress } from "../sync-progress";

/** A game's stored achievements, as the editor shows them. */
export interface AchievementState {
    status?: string;
    /** "retroachievements", "steam", "native_port", ... or "none" (marked by the user). */
    source?: string;
    total: number;
}

interface Loaded {
    metadata: Record<string, GameMetadata>;
    achievements: Record<string, AchievementState>;
    /** Matched to a Steam game, or reported by a store (ADR-0067). */
    storeData: Record<string, boolean>;
    inferred: Record<string, boolean>;
}

const EMPTY: Loaded = { metadata: {}, achievements: {}, storeData: {}, inferred: {} };
let cached: Loaded | null = null;

export interface LibraryIssues {
    /** Every shortcut, by name. */
    games: { appid: number; name: string }[];
    issuesOf(appid: number): IssueKey[];
    /** Whether the game is in the Library Analytics group (the editor's filter). */
    inGroup(appid: number, group: LibraryGroup): boolean;
    achievementsOf(appid: number): AchievementState | undefined;
    /** Nothing fetched yet (the background sync has not reached it). */
    waiting(appid: number): boolean;
    ignored(appid: number): boolean;
    stats: { games: number; metadata: number; achievements: number; excluded: number; issues: number };
    /** The first read of the stored records has not come back yet (nothing cached from an earlier window). */
    loading: boolean;
    refresh(): Promise<void>;
}

export function useLibraryIssues(): LibraryIssues {
    const ctx = usePanelContext();
    const [overrides] = useSetting("controllerOverrides");
    const [ignoredMap] = useSetting("ignoredIssues");
    // Re-render when the rules change (ctx.routing.serviceAllowed reads them).
    useSetting("routingRules");
    const [data, setData] = useState<Loaded>(() => cached ?? EMPTY);
    const [loading, setLoading] = useState(cached === null);
    const sync = useSyncProgress();
    const wasSyncing = useRef(sync.isSyncing);

    const refresh = useCallback(async () => {
        const next: Loaded = { metadata: {}, achievements: {}, storeData: {}, inferred: {} };
        try {
            await ctx.controller.load();
            for (const sc of ctx.routing.listShortcuts()) {
                const v = ctx.controller.inferredFor(sc.appid);
                if (typeof v === "boolean") next.inferred[String(sc.appid)] = v;
            }
        } catch {
            // the default setting applies
        }
        try {
            const res = await backend.getAllRecords();
            for (const [key, parts] of Object.entries(res?.records ?? {})) {
                const meta = parts?.metadata?.data as GameMetadata | undefined;
                if (meta) next.metadata[key] = meta;
                const native = (parts?.identity?.data as any)?.native;
                if (native?.appid || parts?.provided?.data) next.storeData[key] = true;
                const ach = parts?.achievements;
                if (ach) {
                    next.achievements[key] = {
                        status: ach.status,
                        source: ach.source ?? ((ach.status as string) === "none" ? "none" : undefined),
                        total: (ach.data as any)?.schema?.total ?? 0,
                    };
                }
            }
        } catch {
            // keep what is shown
        }
        cached = next;
        setData(next);
        setLoading(false);
    }, [ctx]);

    useEffect(() => {
        void refresh();
        const offSettings = onSettingChange((key) => {
            if (key === "routingRules") void refresh();
        });
        const offProgress = ctx.ingest.onProgress((p) => {
            if (p.isSyncing && p.current > 0 && p.current % 4 === 0) void refresh();
        });
        // Delete metadata (ADR-0097): the counts are read again at once.
        const offLibrary = onLibraryChanged(() => void refresh());
        return () => {
            offSettings();
            offProgress();
            offLibrary();
        };
    }, [refresh, ctx]);

    useEffect(() => {
        if (wasSyncing.current && !sync.isSyncing) void refresh();
        wasSyncing.current = sync.isSyncing;
    }, [sync.isSyncing, refresh]);

    // Shortcuts added or removed while a window shows the list (Steam's list, read every 5 s; cheap: ids only).
    const [, setShortcutsSeen] = useState("");
    useEffect(() => {
        const signature = () => ctx.routing.listShortcuts().map((s) => s.appid).join(",");
        let last = signature();
        const timer = setInterval(() => {
            const now = signature();
            if (now !== last) {
                last = now;
                setShortcutsSeen(now);
            }
        }, 5000);
        return () => clearInterval(timer);
    }, [ctx]);

    const games = ctx.routing.listShortcuts();

    function inputsOf(appid: number) {
        const meta = lookupStored(data.metadata, appid);
        const storeData = lookupStored(data.storeData, appid) === true;
        const ach = lookupStored(data.achievements, appid);
        const live = ctx.records.achievementsOf(appid);
        const hasAchievements = (live?.nTotal ?? 0) > 0 || (ach?.status === "ok" && ach.total > 0);
        const override = lookupStored(overrides, appid);
        const inferred = lookupStored(data.inferred, appid) ?? ctx.controller.inferredFor(appid);
        const controllerKnown =
            (override !== undefined && override !== "auto") ||
            inferred !== undefined ||
            controllerFromPlatforms(meta?.platforms) === true ||
            meta?.categories?.full_controller === true ||
            meta?.categories?.partial_controller === true ||
            storeData;
        return {
            metadata: meta,
            storeData,
            hasAchievements,
            achievementsNone: ach?.source === "none" || ach?.status === "none",
            controllerKnown,
            // With no rule at all nothing is excluded by a rule: the plugin just waits for one (ADR-0089).
            excluded: setting("routingRules").some((r) => r.enabled !== false) && !ctx.routing.serviceAllowed("all", appid),
            ignored: lookupStored(ignoredMap, appid) === true,
        };
    }

    const stats = { games: games.length, metadata: 0, achievements: 0, excluded: 0, issues: 0 };
    const issuesBy = new Map<number, IssueKey[]>();
    // Group membership, worked out once per render from the same inputs as the stats: the picker filters and
    // counts per group without asking the routing again (per-render routing reads swallowed clicks before).
    const groupsBy = new Map<number, Set<LibraryGroup>>();
    for (const g of games) {
        const i = inputsOf(g.appid);
        if (i.excluded) stats.excluded++;
        else {
            if (i.metadata || i.storeData) stats.metadata++;
            if (i.hasAchievements) stats.achievements++;
        }
        const list = gameIssues(i);
        issuesBy.set(g.appid, list);
        if (list.length > 0) stats.issues++;
        const set = new Set<LibraryGroup>(["all"]);
        (["metadata", "achievements", "ignored", "issues"] as const).forEach((group) => {
            if (inGroup(i, group)) set.add(group);
        });
        groupsBy.set(g.appid, set);
    }

    return {
        games,
        issuesOf: (appid) => issuesBy.get(appid) ?? [],
        inGroup: (appid, group) => groupsBy.get(appid)?.has(group) ?? group === "all",
        achievementsOf: (appid) => lookupStored(data.achievements, appid),
        waiting: (appid) => !fetched(inputsOf(appid)),
        ignored: (appid) => lookupStored(ignoredMap, appid) === true,
        stats,
        loading,
        refresh,
    };
}
