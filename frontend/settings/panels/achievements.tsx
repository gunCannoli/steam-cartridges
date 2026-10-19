// Settings: Achievement sources (migration plan M8c, moved verbatim).
import { useEffect, useState } from "react";
import { DialogButton, Dropdown, Field, PanelSection, TextField } from "@steambrew/client";
import { useSetting } from "../settings";
import { backend, type RetroStatusResponse } from "../../ports/backend";
import { usePanelContext } from "../context";
import {
    ActionRow,
    Blocks,
    BUTTON_STYLE,
    ButtonRow,
    CONTROL_GAP,
    CredentialsNote,
    FullWidthRows,
    IconButton,
    ItemRow,
    SettingsModal,
} from "../components";

// ===========================================================================
// 2. {Achievements} Sources Section
// ===========================================================================

interface AchievementSourceDef {
    id: "steam_store" | "retroachievements" | "console_emulators";
    label: string;
}

const ALL_ACHIEVEMENT_SOURCES: AchievementSourceDef[] = [
    { id: "steam_store", label: "Steam Store Mirror" },
    { id: "retroachievements", label: "RetroAchievements" },
    { id: "console_emulators", label: "Emulators" },
];

/** What each source reads, shown under the Source dropdown of the Add popup. */
const SOURCE_DESCRIPTIONS: Record<AchievementSourceDef["id"], string> = {
    steam_store: "The achievement list and rarity of the Steam game a shortcut maps to.",
    retroachievements: "Your RetroAchievements unlocks. Sign in with your username and Web API key.",
    console_emulators: "Reads PS3 / PS4 trophies (RPCS3, shadPS4) and DuckStation, PCSX2, Dolphin, PPSSPP and RPCS3 logs.",
};

export function AchievementsSection() {
    const ctx = usePanelContext();
    const [services, setServices] = useSetting("services");
    const [retroStatus, setRetroStatus] = useState<RetroStatusResponse | null>(
        null,
    );

    const [showAddModal, setShowAddModal] = useState(false);
    const [showEmuModal, setShowEmuModal] = useState(false);
    const [sourceToRegister, setSourceToRegister] = useState<
        "steam_store" | "retroachievements" | "console_emulators"
    >("retroachievements");

    // RA credentials input
    const [raUser, setRaUser] = useState("");
    const [raToken, setRaToken] = useState("");
    const [raMsg, setRaMsg] = useState("");
    const [isSavingRa, setIsSavingRa] = useState(false);

    const refreshRetro = () => {
        backend.getRetroStatus()
            .then(setRetroStatus)
            .catch(() => {});
    };

    useEffect(() => {
        refreshRetro();
    }, []);

    const activeRaUser =
        retroStatus?.emulators?.find((e) => e.authenticated && e.username)
            ?.username ||
        (retroStatus?.env_fallback
            ? retroStatus.env_username || "Configured in .env"
            : null);

    // Active sources calculation
    const activeSources: AchievementSourceDef[] = [];
    const [steamStoreSrc, raSrc, emuSrc] = ALL_ACHIEVEMENT_SOURCES;
    if (steamStoreSrc && services.steamStoreEnabled !== false) {
        activeSources.push(steamStoreSrc);
    }
    if (raSrc && services.retroachievementsEnabled !== false && activeRaUser) {
        activeSources.push(raSrc);
    }
    if (
        emuSrc &&
        services.emulatorsEnabled !== false &&
        services.rpcs3Enabled !== false
    ) {
        activeSources.push(emuSrc);
    }

    const availableToAdd = ALL_ACHIEVEMENT_SOURCES.filter(
        (s) => !activeSources.some((active) => active.id === s.id),
    );

    const handleRemoveSource = (
        id: "steam_store" | "retroachievements" | "console_emulators",
    ) => {
        if (id === "steam_store") {
            setServices({ ...services, steamStoreEnabled: false });
        } else if (id === "retroachievements") {
            setServices({ ...services, retroachievementsEnabled: false });
        } else if (id === "console_emulators") {
            setServices({
                ...services,
                emulatorsEnabled: false,
                rpcs3Enabled: false,
            });
        }
        ctx.ingest.trigger(250);
    };

    const handleOpenAddModal = () => {
        const first = availableToAdd[0];
        if (first) {
            setSourceToRegister(first.id);
            setRaMsg("");
            setShowAddModal(true);
        }
    };

    const handleRegisterSource = async () => {
        setIsSavingRa(true);
        setRaMsg("Saving...");

        if (sourceToRegister === "steam_store") {
            setServices({ ...services, steamStoreEnabled: true });
            ctx.ingest.trigger(250);
            setRaMsg("✓ Steam Store Mirror added");
            setTimeout(() => {
                setShowAddModal(false);
                setIsSavingRa(false);
                setRaMsg("");
            }, 1000);
            return;
        }

        if (sourceToRegister === "console_emulators") {
            setServices({
                ...services,
                emulatorsEnabled: true,
                rpcs3Enabled: true,
            });
            ctx.ingest.trigger(250);
            setRaMsg("✓ Emulators added");
            setTimeout(() => {
                setShowAddModal(false);
                setIsSavingRa(false);
                setRaMsg("");
            }, 1000);
            return;
        }

        if (sourceToRegister === "retroachievements") {
            if (!raUser.trim() || !raToken.trim()) {
                setRaMsg("Username and API token are required.");
                setIsSavingRa(false);
                return;
            }
            const res = await backend.saveServiceCredentials({
                retroachievements_user: raUser.trim(),
                retroachievements_api: raToken.trim(),
            });
            if (res.success) {
                setServices({ ...services, retroachievementsEnabled: true });
                ctx.ingest.trigger(250);
                refreshRetro();
                setRaMsg("✓ RetroAchievements added");
                setTimeout(() => {
                    setShowAddModal(false);
                    setIsSavingRa(false);
                    setRaMsg("");
                    setRaToken("");
                }, 1200);
            } else {
                setRaMsg("Failed to save credentials.");
                setIsSavingRa(false);
            }
            return;
        }
    };

    return (
        <PanelSection title="Achievements">
            <Blocks>
                {activeSources.length > 0 && (
                    <>
                        {activeSources.map((src) => (
                            <ItemRow key={src.id}>
                                <Field label={src.label}>
                                    <div style={{ display: "flex", alignItems: "center", gap: CONTROL_GAP }}>
                                        {src.id === "console_emulators" && (
                                            <IconButton onClick={() => setShowEmuModal(true)} title="Emulator status">
                                                🛈
                                            </IconButton>
                                        )}
                                        <IconButton onClick={() => handleRemoveSource(src.id)} title="Remove">
                                            🗑️
                                        </IconButton>
                                    </div>
                                </Field>
                            </ItemRow>
                        ))}
                    </>
                )}
                {availableToAdd.length > 0 && (
                    <ButtonRow
                        label="Add source"
                        description="Connect another source of achievements"
                        buttonLabel="Add"
                        onClick={handleOpenAddModal}
                    />
                )}
            </Blocks>

            {/* Add Source popup: the same rows and spacing as the panel. */}
            <SettingsModal title="Add Achievements Source" isOpen={showAddModal} onClose={() => setShowAddModal(false)}>
                <PanelSection>
                    <Blocks>
                        <FullWidthRows label="Source" description={SOURCE_DESCRIPTIONS[sourceToRegister]}>
                            <Dropdown
                                rgOptions={availableToAdd.map((s) => ({ data: s.id, label: s.label }))}
                                selectedOption={sourceToRegister}
                                onChange={(o) => setSourceToRegister(o.data as AchievementSourceDef["id"])}
                                contextMenuPositionOptions={{ bMatchWidth: true }}
                            />
                        </FullWidthRows>
                        {sourceToRegister === "retroachievements" && (
                            <>
                                <ItemRow trailing>
                                    <TextField label="Username" value={raUser} onChange={(e) => setRaUser(e.target.value)} />
                                </ItemRow>
                                <ItemRow trailing>
                                    <TextField label="Web API Key" bIsPassword value={raToken} onChange={(e) => setRaToken(e.target.value)} />
                                </ItemRow>
                                <CredentialsNote service="RetroAchievements" />
                            </>
                        )}
                        <ActionRow message={raMsg}>
                            <DialogButton disabled={isSavingRa} onClick={handleRegisterSource} style={BUTTON_STYLE}>
                                Add
                            </DialogButton>
                            <DialogButton onClick={() => setShowAddModal(false)} style={BUTTON_STYLE}>
                                Cancel
                            </DialogButton>
                        </ActionRow>
                    </Blocks>
                </PanelSection>
            </SettingsModal>

            {/* Emulator status popup: one row per emulator. */}
            <SettingsModal title="Emulator Status" isOpen={showEmuModal} onClose={() => setShowEmuModal(false)} width="480px">
                <PanelSection>
                    <Blocks>
                        <>
                            {retroStatus?.emulators?.map((emu) => (
                                <ItemRow key={emu.name}>
                                    <Field
                                        label={emu.name}
                                        description={
                                            emu.authenticated
                                                ? `Signed in as ${emu.username}`
                                                : emu.detected
                                                  ? "Found, not signed in"
                                                  : "Not found"
                                        }
                                    >
                                        <span style={{ color: emu.detected ? "#a4d007" : "#8b929a" }}>{emu.detected ? "✓" : "✗"}</span>
                                    </Field>
                                </ItemRow>
                            ))}
                        </>
                        <ActionRow>
                            <DialogButton onClick={() => setShowEmuModal(false)} style={BUTTON_STYLE}>
                                Close
                            </DialogButton>
                        </ActionRow>
                    </Blocks>
                </PanelSection>
            </SettingsModal>
        </PanelSection>
    );
}
