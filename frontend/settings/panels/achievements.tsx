// Settings: Achievement sources. The sources in use and "Add source"; the Add popup is its own window (add-service.tsx).
import { useEffect, useState } from "react";
import { DialogButton, Field, PanelSection } from "@steambrew/client";
import { useSetting } from "../settings";
import { backend, type RetroStatusResponse } from "../../ports/backend";
import { usePanelContext } from "../context";
import { ActionRow, Blocks, BUTTON_STYLE, ButtonRow, CONTROL_GAP, IconButton, ItemRow, SettingsModal } from "../components";
import { ADD_SERVICE_SCALE, AddServiceWindow, type Addable } from "./add-service";

type AchievementSourceId = "retroachievements" | "console_emulators" | "native_ports";

interface AchievementSourceDef extends Addable {
    id: AchievementSourceId;
}

const ALL_ACHIEVEMENT_SOURCES: AchievementSourceDef[] = [
    { id: "retroachievements", label: "RetroAchievements" },
    { id: "console_emulators", label: "Emulators" },
    { id: "native_ports", label: "Native ports" },
];

export function AchievementsSection() {
    const ctx = usePanelContext();
    const [services, setServices] = useSetting("services");
    const [retroStatus, setRetroStatus] = useState<RetroStatusResponse | null>(null);
    const [showEmuModal, setShowEmuModal] = useState(false);
    const [showPortsModal, setShowPortsModal] = useState(false);
    const [ports, setPorts] = useState<{ id: string; name: string; detected: number }[] | null>(null);

    const refreshRetro = () => {
        backend
            .getRetroStatus()
            .then(setRetroStatus)
            .catch((e) => backend.logEvent("sources", `achievements status read failed: ${String(e?.message ?? e).slice(0, 100)}`));
    };

    useEffect(() => {
        refreshRetro();
        backend
            .getNativePortsStatus()
            .then((res) => setPorts(res.ports ?? []))
            .catch((e) => backend.logEvent("sources", `native ports status read failed: ${String(e?.message ?? e).slice(0, 100)}`));
    }, []);

    const activeRaUser =
        retroStatus?.emulators?.find((e) => e.authenticated && e.username)?.username ||
        (retroStatus?.env_fallback ? retroStatus.env_username || "Configured in .env" : null);

    // A source is in use once the user turned it on (nothing is on by default); RetroAchievements also needs an account.
    const activeSources = ALL_ACHIEVEMENT_SOURCES.filter((s) =>
        s.id === "retroachievements"
            ? services.retroachievementsEnabled === true && !!activeRaUser
            : s.id === "native_ports"
              ? services.nativePortsEnabled === true
              : services.emulatorsEnabled === true && services.rpcs3Enabled !== false,
    );
    const availableToAdd = ALL_ACHIEVEMENT_SOURCES.filter((s) => !activeSources.some((active) => active.id === s.id));

    const handleRemoveSource = (id: AchievementSourceId) => {
        if (id === "retroachievements") setServices({ ...services, retroachievementsEnabled: false });
        else if (id === "native_ports") setServices({ ...services, nativePortsEnabled: false });
        else setServices({ ...services, emulatorsEnabled: false, rpcs3Enabled: false });
        backend.logEvent("sources", `${id} removed`);
        ctx.ingest.trigger(250, "services");
    };

    const openAdd = (e?: { currentTarget?: unknown }) => {
        const from = (e?.currentTarget as Element | undefined)?.ownerDocument?.defaultView ?? undefined;
        ctx.dialog.open(<AddServiceWindow title="Add Achievements Source" options={availableToAdd} onAdded={refreshRetro} />, "Add Achievements Source", refreshRetro, from, ADD_SERVICE_SCALE);
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
                                        {src.id === "native_ports" && (
                                            <IconButton onClick={() => setShowPortsModal(true)} title="Supported native ports">
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
                    <ButtonRow label="Add source" description="Connect a source of achievements" buttonLabel="Add" onClick={openAdd as () => void} />
                )}
            </Blocks>

            {/* Native ports popup: every supported port and how many shortcuts launch it. */}
            <SettingsModal title="Native Ports" isOpen={showPortsModal} onClose={() => setShowPortsModal(false)} width="480px">
                <PanelSection>
                    <Blocks>
                        <>
                            {(ports ?? []).map((p) => (
                                <ItemRow key={p.id}>
                                    <Field label={p.name} description={p.detected > 0 ? `Found in ${p.detected} shortcut${p.detected === 1 ? "" : "s"}` : "Not found in your library"}>
                                        <span style={{ color: p.detected > 0 ? "#a4d007" : "#8b929a" }}>{p.detected > 0 ? "✓" : "✗"}</span>
                                    </Field>
                                </ItemRow>
                            ))}
                        </>
                        <ActionRow>
                            <DialogButton onClick={() => setShowPortsModal(false)} style={BUTTON_STYLE}>
                                Close
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
                                        description={emu.authenticated ? `Signed in as ${emu.username}` : emu.detected ? (emu.note ? `Found, not signed in. ${emu.note}` : "Found, not signed in") : "Not found"}
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
