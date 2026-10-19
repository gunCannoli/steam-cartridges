// Settings: Library Audit (migration plan M8c; reads the app through the panel context and the backend port).
import { useCallback, useEffect, useRef, useState } from "react";
import {
    DialogButton,
    Dropdown,
    Field,
    PanelSection,
    TextField,
} from "@steambrew/client";
import {
    onSettingChange,
    setSetting,
    useSetting,
    type ControllerOverride,
} from "../settings";
import { backend } from "../../ports/backend";
import type { AutoRoutingProfile } from "../../domain/routing/policy";
import { type GameMetadata } from "../../kernel/record";
import { lookupStored } from "../../kernel/appid";
import { usePanelContext } from "../context";
import {
    ActionRow,
    Blocks,
    BUTTON_STYLE,
    ButtonRow,
    CARD_BACKGROUND,
    FullWidthRows,
    ItemRow,
    SettingsModal,
    StatRow,
} from "../components";
import { GameDataEditor } from "../game-editor/modal";
import { useSyncProgress } from "../sync-progress";

// ===========================================================================
// 5. {Revision} & Game Audit Center Section
// ===========================================================================

interface FlaggedShortcut {
    appid: number;
    name: string;
    missingController: boolean;
    noAchievements: boolean;
    inferred?: boolean;
    profile?: AutoRoutingProfile;
}

interface StoredAchievementRecord {
    status?: string;
    source?: string;
    total?: number;
    title?: string;
}

const CONTROLLER_OVERRIDE_OPTIONS = [
    { data: "auto", label: "Default / Auto" },
    { data: "full", label: "Full Controller Support" },
    { data: "partial", label: "Partial Controller Support" },
    { data: "none", label: "Keyboard & Mouse" },
];

let cachedMetadataLib: Record<string, GameMetadata> | null = null;
let cachedAutoProfiles: Record<string, AutoRoutingProfile> | null = null;
let cachedControllerInference: Record<string, boolean> | null = null;
let cachedAchievementsLib: Record<string, StoredAchievementRecord> | null = null;
let cachedIdentityLib: Record<string, { appid: number; source?: string }> | null = null;
let cachedStoreLib: Record<string, { kind: string; title?: string }> | null = null;

export function RevisionSection() {
    const ctx = usePanelContext();
    const [controllerOverrides] = useSetting("controllerOverrides");
    // Re-render when the rules or Auto Mode change (ctx.routing.serviceAllowed reads them).
    useSetting("routingRules");
    useSetting("autoRoutingMode");
    const [autoProfiles, setAutoProfiles] = useState<
        Record<string, AutoRoutingProfile>
    >(() => cachedAutoProfiles || {});
    const [metadataLib, setMetadataLib] = useState<
        Record<string, GameMetadata>
    >(() => cachedMetadataLib || {});
    const [achievementsLib, setAchievementsLib] = useState<
        Record<string, StoredAchievementRecord>
    >(() => cachedAchievementsLib || {});
    const [identityLib, setIdentityLib] = useState<
        Record<string, { appid: number; source?: string }>
    >(() => cachedIdentityLib || {});
    const [storeLib, setStoreLib] = useState<
        Record<string, { kind: string; title?: string }>
    >(() => cachedStoreLib || {});
    const [controllerInference, setControllerInference] = useState<
        Record<string, boolean>
    >(() => cachedControllerInference || {});
    const [isAuditModalOpen, setIsAuditModalOpen] = useState(false);
    const [isGameDataOpen, setIsGameDataOpen] = useState(false);
    const [filter, setFilter] = useState<
        "all" | "missing_achievements" | "missing_controller" | "not_scraped"
    >("all");
    const [targetAppId, setTargetAppId] = useState<number | null>(null);
    const [steamIdInput, setSteamIdInput] = useState("");
    const [raInput, setRaInput] = useState("");
    const [igdbInput, setIgdbInput] = useState("");
    const [fixMsg, setFixMsg] = useState("");
    const syncProgress = useSyncProgress();
    const prevSyncingRef = useRef(syncProgress.isSyncing);

    const shortcuts = ctx.routing.listShortcuts();
    const shortcutName = (appid: number): string =>
        shortcuts.find((s) => s.appid === appid)?.name ?? String(appid);

    const refreshAuditData = useCallback(async () => {
        await ctx.controller.load();
        try {
            await ctx.routing.reloadProfiles();
            const profiles: Record<string, AutoRoutingProfile> = {};
            const inference: Record<string, boolean> = {};
            for (const sc of ctx.routing.listShortcuts()) {
                const profile = ctx.routing.getAutoRoutingProfile(sc.appid);
                if (profile) profiles[String(sc.appid)] = profile;
                const inferred = ctx.controller.inferredFor(sc.appid);
                if (typeof inferred === "boolean")
                    inference[String(sc.appid)] = inferred;
            }
            cachedAutoProfiles = profiles;
            setAutoProfiles(profiles);
            cachedControllerInference = inference;
            setControllerInference(inference);
        } catch {
            // ignore
        }
        try {
            const res = await backend.getAllRecords();
            const library: Record<string, GameMetadata> = {};
            const achLib: Record<string, StoredAchievementRecord> = {};
            const idLib: Record<string, { appid: number; source?: string }> = {};
            const stLib: Record<string, { kind: string; title?: string }> = {};
            for (const [key, recordParts] of Object.entries(
                res?.records ?? {},
            )) {
                const data = recordParts?.metadata?.data as
                    | GameMetadata
                    | undefined;
                if (data) library[key] = data;

                const idData = (recordParts?.identity?.data as any)?.native;
                if (idData?.appid) {
                    idLib[key] = { appid: idData.appid, source: idData.source };
                }

                // What an extension pushed (ADR-0067: an Epic or Xbox copy) counts as matched.
                const pushed = recordParts?.provided?.data as any;
                if (pushed) {
                    stLib[key] = { kind: pushed.source, title: pushed.title };
                }

                const achPart = recordParts?.achievements;
                if (achPart) {
                    const schema = (achPart.data as any)?.schema;
                    achLib[key] = {
                        status: achPart.status,
                        source: achPart.source,
                        total: schema?.total ?? 0,
                        title: schema?.title,
                    };
                }
            }
            cachedMetadataLib = library;
            setMetadataLib(library);
            cachedAchievementsLib = achLib;
            setAchievementsLib(achLib);
            cachedIdentityLib = idLib;
            setIdentityLib(idLib);
            cachedStoreLib = stLib;
            setStoreLib(stLib);
        } catch {
            // ignore
        }
    }, [ctx]);

    useEffect(() => {
        refreshAuditData();
        // Rules or Auto Mode changed (the settings store's own events), or a sync made progress (every 4 games).
        const offSettings = onSettingChange((key) => {
            if (key === "routingRules" || key === "autoRoutingMode")
                void refreshAuditData();
        });
        const offProgress = ctx.ingest.onProgress((p) => {
            if (p.isSyncing && p.current > 0 && p.current % 4 === 0)
                void refreshAuditData();
        });
        return () => {
            offSettings();
            offProgress();
        };
    }, [refreshAuditData, ctx]);

    useEffect(() => {
        if (prevSyncingRef.current && !syncProgress.isSyncing) {
            void refreshAuditData();
        }
        prevSyncingRef.current = syncProgress.isSyncing;
    }, [syncProgress.isSyncing, refreshAuditData]);

    const flagged: FlaggedShortcut[] = [];
    const notScraped: {
        appid: number;
        name: string;
        profile?: AutoRoutingProfile;
    }[] = [];
    let ignored = 0;
    let matched = 0;
    let achievementsMatched = 0;

    for (const sc of shortcuts) {
        const profile = lookupStored(autoProfiles, sc.appid);

        // Excluded by routing rules or auto mode (app/routing, the one evaluation)
        const isAllowed = ctx.routing.serviceAllowed("all", sc.appid);
        if (!isAllowed) {
            ignored++;
            continue; // Excluded by rule / auto mode: do not count in issues or not-scraped
        }

        const meta = lookupStored(metadataLib, sc.appid);
        const isSteamMapped = (lookupStored(identityLib, sc.appid)?.appid ?? 0) > 0;
        const isStoreCopy = lookupStored(storeLib, sc.appid) != null;

        if (meta || isSteamMapped || isStoreCopy) matched++;

        const achSummary = ctx.records.achievementsOf(sc.appid);
        const achRecord = lookupStored(achievementsLib, sc.appid);
        const hasAchievements =
            (achSummary && achSummary.nTotal > 0) ||
            (achRecord && achRecord.status === "ok" && (achRecord.total ?? 0) > 0);

        if (hasAchievements) {
            achievementsMatched++;
        }

        const isScraped = !!meta || isSteamMapped || isStoreCopy || hasAchievements;
        if (!isScraped) {
            notScraped.push({ appid: sc.appid, name: sc.name, profile });
            continue; // Do NOT count unscraped games as issues!
        }

        const override = lookupStored(controllerOverrides, sc.appid);
        const inferred =
            lookupStored(controllerInference, sc.appid) ??
            ctx.controller.inferredFor(sc.appid);
        const hasControllerSupport =
            override === "full" ||
            override === "partial" ||
            (override !== "none" && (
                inferred === true ||
                meta?.categories?.full_controller === true ||
                meta?.categories?.partial_controller === true ||
                isSteamMapped ||
                isStoreCopy
            ));
        const missingController =
            !hasControllerSupport && (!override || override === "auto");

        const noAchievements = !hasAchievements && achRecord?.source !== "none";

        // Actionable issues: unknown controller input or missing achievements
        if (missingController || noAchievements) {
            flagged.push({
                appid: sc.appid,
                name: sc.name,
                missingController,
                noAchievements,
                inferred,
                profile,
            });
        }
    }

    const handleSetController = (appid: number, val: ControllerOverride) => {
        // The setting is written before Game Info re-derives the badges, so a change made here shows at once.
        void setSetting("controllerOverrides", {
            ...controllerOverrides,
            [String(appid)]: val,
        }).then(() => ctx.controller.refresh(appid));
        setFixMsg(`✓ Updated controller support for ${shortcutName(appid)}`);
        setTimeout(() => setFixMsg(""), 2500);
    };

    const handleLinkSteamApp = async (
        shortcutAppId: number,
        steamAppId: number,
    ) => {
        setFixMsg("Linking to Steam Store...");
        const res = await ctx.steamStore.setMapping(shortcutAppId, steamAppId);
        if (res.mapping) {
            void backend
                .setAchievementSource(shortcutAppId, "steam", steamAppId)
                .catch(() => {});
            setFixMsg("✓ Linked to Steam");
            setSteamIdInput("");
            await ctx.records.refreshAchievements?.(shortcutAppId);
            await refreshAuditData();
            setTimeout(() => setFixMsg(""), 2500);
        } else {
            setFixMsg(res.error || "Failed to map Steam App");
        }
    };

    const handleLinkRA = async (appid: number, input: string) => {
        if (!input.trim()) return;
        setFixMsg(`Linking RetroAchievements for ${shortcutName(appid)}...`);
        try {
            const res = await backend.setAchievementSource(
                appid,
                "ra",
                input.trim(),
            );
            if (res.ok) {
                setFixMsg(
                    `✓ Linked RetroAchievements: ${res.title || "Game"} (${res.total || 0} achievements)`,
                );
                setRaInput("");
                await ctx.records.refreshAchievements?.(appid);
                await refreshAuditData();
                setTimeout(() => setFixMsg(""), 3500);
            } else {
                setFixMsg(`Failed to link RA: ${res.error || "Unknown error"}`);
            }
        } catch (e: any) {
            setFixMsg(`Error linking RA: ${e?.message || e}`);
        }
    };

    const handleLinkIgdb = async (appid: number, input: string) => {
        const id = parseInt(input.trim(), 10);
        if (!id || isNaN(id) || id <= 0) return;
        setFixMsg(`Linking IGDB metadata for ${shortcutName(appid)}...`);
        try {
            const res = await backend.igdbLink(appid, id);
            if (res.ok) {
                setFixMsg(`✓ Linked IGDB: ${res.metadata?.title || "Game"} (#${id})`);
                setIgdbInput("");
                await refreshAuditData();
                setTimeout(() => setFixMsg(""), 3500);
            } else {
                setFixMsg(`Failed to link IGDB: ${res.error || "Unknown error"}`);
            }
        } catch (e: any) {
            setFixMsg(`Error linking IGDB: ${e?.message || e}`);
        }
    };

    const handleSetNoAchievements = async (appid: number) => {
        setFixMsg(
            `Marking ${shortcutName(appid)} as having no achievements...`,
        );
        try {
            const res = await backend.setAchievementSource(appid, "none");
            if (res.ok) {
                setFixMsg(
                    `✓ Marked as having no achievements for ${shortcutName(appid)}`,
                );
                await ctx.records.refreshAchievements?.(appid);
                await refreshAuditData();
                setTimeout(() => setFixMsg(""), 2500);
            } else {
                setFixMsg(`Failed: ${res.error || "Unknown error"}`);
            }
        } catch (e: any) {
            setFixMsg(`Error: ${e?.message || e}`);
        }
    };

    const handleClearAchievements = async (appid: number) => {
        setFixMsg(`Clearing achievement source for ${shortcutName(appid)}...`);
        try {
            const res = await backend.clearAchievementSource(appid);
            if (res.ok) {
                setFixMsg(
                    `✓ Cleared achievement source for ${shortcutName(appid)}`,
                );
                await ctx.records.refreshAchievements?.(appid);
                await refreshAuditData();
                setTimeout(() => setFixMsg(""), 2500);
            } else {
                setFixMsg(`Failed: ${res.error || "Unknown error"}`);
            }
        } catch (e: any) {
            setFixMsg(`Error: ${e?.message || e}`);
        }
    };

    const handleScanSingle = async (appid: number, name: string) => {
        setFixMsg(`Scanning ${name}...`);
        await ctx.ingest
            .start({ forceAll: true, onlyAppids: [appid] })
            .catch(() => {});
        await refreshAuditData();
        setFixMsg(`✓ Scanned ${name}`);
        setTimeout(() => setFixMsg(""), 2000);
    };

    const displayedFlagged =
        filter === "missing_achievements"
            ? flagged.filter((f) => f.noAchievements)
            : filter === "missing_controller"
              ? flagged.filter((f) => f.missingController)
              : flagged;

    return (
        <div
            style={{
                display:
                    syncProgress.isSyncing && !isAuditModalOpen
                        ? "none"
                        : "block",
            }}
        >
            <PanelSection title="Library Analytics">
                <Blocks>
                    <>
                        <StatRow
                            label="Non-Steam Games"
                            value={shortcuts.length}
                        />
                        <StatRow label="Metadata Match" value={matched} />
                        <StatRow
                            label="Achievements Match"
                            value={achievementsMatched}
                        />
                        <StatRow label="Excluded/Ignored" value={ignored} />
                        <StatRow
                            label="Issues detected"
                            value={flagged.length}
                            warn
                        />
                    </>
                    {/* Only when there is something to fix. */}
                    {flagged.length > 0 && (
                        <FullWidthRows
                            label="Review"
                            description="Review detected issues and configure overrides"
                        >
                            <DialogButton
                                onClick={() => {
                                    setFilter("all");
                                    setIsAuditModalOpen(true);
                                }}
                                style={{ ...BUTTON_STYLE, width: "100%" }}
                            >
                                Review
                            </DialogButton>
                        </FullWidthRows>
                    )}
                    <FullWidthRows
                        label="Edit Game MetaData"
                        description="Edit game details, links, and controller support"
                    >
                        <DialogButton
                            onClick={() => setIsGameDataOpen(true)}
                            style={{ ...BUTTON_STYLE, width: "100%" }}
                        >
                            Manual Edit
                        </DialogButton>
                    </FullWidthRows>
                    {fixMsg && !isAuditModalOpen && (
                        <ActionRow message={fixMsg} />
                    )}
                </Blocks>
                <GameDataEditor
                    isOpen={isGameDataOpen}
                    onClose={() => setIsGameDataOpen(false)}
                />

                {/* Review popup: one block per game. */}
                <SettingsModal
                    title="Review"
                    isOpen={isAuditModalOpen}
                    onClose={() => setIsAuditModalOpen(false)}
                    width="640px"
                    maxHeight="85vh"
                >
                    <PanelSection>
                        <Blocks>
                            <FullWidthRows
                                label="Show"
                                description={
                                    filter === "not_scraped"
                                        ? "Games queued for background fetch"
                                        : filter === "missing_achievements"
                                          ? "Games with no detected achievements"
                                          : filter === "missing_controller"
                                            ? "Games with unconfigured controller input"
                                            : "Games requiring attention"
                                }
                            >
                                <Dropdown
                                    rgOptions={[
                                        {
                                           data: "all",
                                           label: `All Issues (${flagged.length})`,
                                        },
                                        {
                                           data: "missing_achievements",
                                           label: `Missing Achievements (${flagged.filter((f) => f.noAchievements).length})`,
                                        },
                                        {
                                           data: "missing_controller",
                                           label: `Missing Controller (${flagged.filter((f) => f.missingController).length})`,
                                        },
                                        {
                                           data: "not_scraped",
                                           label: `Not scraped (${notScraped.length})`,
                                        },
                                    ]}
                                    selectedOption={filter}
                                    onChange={(o) =>
                                        setFilter(
                                            o.data as
                                                | "all"
                                                | "missing_achievements"
                                                | "missing_controller"
                                                | "not_scraped",
                                        )
                                    }
                                    contextMenuPositionOptions={{
                                        bMatchWidth: true,
                                    }}
                                />
                            </FullWidthRows>
                            {displayedFlagged.length > 0 && filter !== "not_scraped" && (
                                <ButtonRow
                                    label={`Scan all ${displayedFlagged.length} game(s)`}
                                    description="Queue background fetch for all listed games"
                                    buttonLabel="Fetch All"
                                    onClick={() => {
                                        const ids = displayedFlagged.map((f) => f.appid);
                                        void ctx.ingest.start({ onlyAppids: ids, forceAll: false });
                                        setFixMsg(`Queued background fetch for ${ids.length} game(s)`);
                                        setTimeout(() => setFixMsg(""), 3000);
                                    }}
                                />
                            )}
                            {fixMsg && <ActionRow message={fixMsg} />}
                            {filter === "not_scraped" ? (
                                notScraped.length === 0 ? (
                                    <ItemRow>
                                        <Field
                                            label="Every game has been fetched"
                                            bottomSeparator="none"
                                        />
                                    </ItemRow>
                                ) : (
                                    notScraped.map((item) => (
                                        <div
                                            key={item.appid}
                                            style={{
                                                background: CARD_BACKGROUND,
                                                borderRadius: "4px",
                                                border: "1px solid rgba(255, 255, 255, 0.08)",
                                                overflow: "hidden",
                                            }}
                                        >
                                            <ButtonRow
                                                label={item.name}
                                                description={gameLine(
                                                    item.appid,
                                                    item.profile,
                                                )}
                                                buttonLabel="Fetch"
                                                onClick={() =>
                                                    handleScanSingle(
                                                        item.appid,
                                                        item.name,
                                                    )
                                                }
                                            />
                                        </div>
                                    ))
                                )
                            ) : displayedFlagged.length === 0 ? (
                                <ItemRow>
                                    <Field
                                        label={
                                            filter === "missing_achievements"
                                                ? "No missing achievements"
                                                : filter === "missing_controller"
                                                  ? "No controller issues"
                                                  : "No issues found"
                                        }
                                        bottomSeparator="none"
                                    />
                                </ItemRow>
                            ) : (
                                displayedFlagged.map((item) => (
                                    <div
                                        key={item.appid}
                                        style={{
                                            background: CARD_BACKGROUND,
                                            borderRadius: "4px",
                                            border: "1px solid rgba(255, 255, 255, 0.08)",
                                            overflow: "hidden",
                                        }}
                                    >
                                        <ItemRow>
                                            <Field
                                                label={item.name}
                                                description={[
                                                    gameLine(
                                                        item.appid,
                                                        item.profile,
                                                    ),
                                                    item.noAchievements
                                                        ? "Missing achievements"
                                                        : null,
                                                    item.missingController
                                                        ? item.inferred === true
                                                            ? "Detected: full controller"
                                                            : item.inferred ===
                                                                false
                                                              ? "Detected: keyboard & mouse"
                                                              : "Unknown controller"
                                                        : null,
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                                bottomSeparator="none"
                                            />
                                        </ItemRow>
                                        {item.missingController && (
                                            <FullWidthRows
                                                label="Controller override"
                                                description="Select controller support for this game"
                                            >
                                                <Dropdown
                                                    rgOptions={
                                                        CONTROLLER_OVERRIDE_OPTIONS
                                                    }
                                                    selectedOption={
                                                        controllerOverrides[
                                                            String(item.appid)
                                                        ] || "auto"
                                                    }
                                                    onChange={(o) =>
                                                        handleSetController(
                                                            item.appid,
                                                            o.data as ControllerOverride,
                                                        )
                                                    }
                                                    contextMenuPositionOptions={{
                                                        bMatchWidth: true,
                                                    }}
                                                />
                                            </FullWidthRows>
                                        )}
                                        {item.noAchievements && (
                                            <>
                                                <ItemRow trailing>
                                                    <TextField
                                                        label="RetroAchievements URL or ID"
                                                        value={
                                                            targetAppId ===
                                                            item.appid
                                                                ? raInput
                                                                : ""
                                                        }
                                                        onChange={(e) => {
                                                            setTargetAppId(
                                                                item.appid,
                                                            );
                                                            setRaInput(
                                                                e.target.value,
                                                            );
                                                        }}
                                                    />
                                                </ItemRow>
                                                <ButtonRow
                                                    label="Link RetroAchievements"
                                                    description="Link by game ID or URL"
                                                    buttonLabel="Link RA"
                                                    disabled={
                                                        targetAppId !==
                                                            item.appid ||
                                                        !raInput.trim()
                                                    }
                                                    onClick={() =>
                                                        handleLinkRA(
                                                            item.appid,
                                                            raInput,
                                                        )
                                                    }
                                                />
                                            </>
                                        )}
                                        <ButtonRow
                                            label="Scan Game"
                                            description="Fetch metadata and achievements now"
                                            buttonLabel="Fetch"
                                            onClick={() => handleScanSingle(item.appid, item.name)}
                                        />
                                        <ItemRow trailing>
                                            <TextField
                                                label="Steam App ID"
                                                value={
                                                    targetAppId === item.appid
                                                        ? steamIdInput
                                                        : ""
                                                }
                                                onChange={(e) => {
                                                    setTargetAppId(item.appid);
                                                    setSteamIdInput(
                                                        e.target.value,
                                                    );
                                                }}
                                            />
                                        </ItemRow>
                                        <ButtonRow
                                            label="Link to Steam"
                                            description="Match with a Steam store game"
                                            buttonLabel="Link"
                                            disabled={
                                                targetAppId !== item.appid ||
                                                !(
                                                    parseInt(
                                                        steamIdInput,
                                                        10,
                                                    ) > 0
                                                )
                                            }
                                            onClick={() =>
                                                handleLinkSteamApp(
                                                    item.appid,
                                                    parseInt(
                                                        steamIdInput,
                                                        10,
                                                    ),
                                                )
                                            }
                                        />
                                        <ItemRow trailing>
                                            <TextField
                                                label="IGDB ID"
                                                value={
                                                    targetAppId === item.appid
                                                        ? igdbInput
                                                        : ""
                                                }
                                                onChange={(e) => {
                                                    setTargetAppId(item.appid);
                                                    setIgdbInput(
                                                        e.target.value,
                                                    );
                                                }}
                                            />
                                        </ItemRow>
                                        <ButtonRow
                                            label="Link to IGDB"
                                            description="Fetch metadata by numeric ID"
                                            buttonLabel="Link IGDB"
                                            disabled={
                                                targetAppId !== item.appid ||
                                                !(
                                                    parseInt(
                                                        igdbInput,
                                                        10,
                                                    ) > 0
                                                )
                                            }
                                            onClick={() =>
                                                handleLinkIgdb(
                                                    item.appid,
                                                    igdbInput,
                                                )
                                            }
                                        />
                                        {item.noAchievements && (
                                            <ButtonRow
                                                label="No Achievements"
                                                description="Mark as having no achievements"
                                                buttonLabel="Mark None"
                                                onClick={() =>
                                                    handleSetNoAchievements(
                                                        item.appid,
                                                    )
                                                }
                                            />
                                        )}
                                        {lookupStored(achievementsLib, item.appid)?.source && (
                                            <ButtonRow
                                                label="Reset Achievement Source"
                                                description="Clear manual override"
                                                buttonLabel="Reset"
                                                onClick={() =>
                                                    handleClearAchievements(
                                                        item.appid,
                                                    )
                                                }
                                            />
                                        )}
                                    </div>
                                ))
                            )}
                            <ActionRow>
                                <DialogButton
                                    onClick={() => setIsAuditModalOpen(false)}
                                    style={BUTTON_STYLE}
                                >
                                    Done
                                </DialogButton>
                            </ActionRow>
                        </Blocks>
                    </PanelSection>
                </SettingsModal>
            </PanelSection>
        </div>
    );
}

/** A game's second line in the Review popup: what kind of game it is, and its app id. */
function gameLine(appid: number, profile?: AutoRoutingProfile): string {
    const kind =
        profile?.category === "retroarch"
            ? "Retro"
            : profile?.category === "console_emulator"
              ? profile.program || "Emulator"
              : profile
                ? "PC"
                : null;
    return kind ? `${kind} · ${appid}` : String(appid);
}
