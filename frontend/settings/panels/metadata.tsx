// Settings: Metadata services (migration plan M8c, moved verbatim).
import { useEffect, useState } from "react";
import {
    DialogButton,
    Dropdown,
    Field,
    PanelSection,
    TextField,
} from "@steambrew/client";
import { useSetting } from "../settings";
import { backend, type ProviderStatus } from "../../ports/backend";
import { usePanelContext } from "../context";
import {
    ActionRow,
    Blocks,
    BUTTON_STYLE,
    ButtonRow,
    CredentialsNote,
    FullWidthRows,
    IconButton,
    ItemRow,
    SettingsModal,
} from "../components";
import { saveAndCheck } from "../service-check";

// ===========================================================================
// 1. {Metadata} Services Section
// ===========================================================================

type MetadataServiceId =
    | "steam_store"
    | "screenscraper"
    | "igdb"
    | "steamgriddb";

interface MetadataServiceDef {
    id: MetadataServiceId;
    label: string;
}

const ALL_METADATA_SERVICES: MetadataServiceDef[] = [
    { id: "steam_store", label: "Steam Store Mirror" },
    { id: "screenscraper", label: "ScreenScraper" },
    { id: "igdb", label: "IGDB" },
    { id: "steamgriddb", label: "SteamGridDB" },
];

/** What each service brings, shown under the Service dropdown of the Add popup. */
const SERVICE_DESCRIPTIONS: Record<MetadataServiceId, string> = {
    steam_store: "Game Info from the matching Steam Store page. No account needed.",
    screenscraper: "Game Info, screenshots, artwork and manuals for retro games. Sign in with your screenscraper.fr account.",
    igdb: "Game Info, trailers and artwork. Needs a Twitch developer app's Client ID and Secret.",
    steamgriddb: "Fills empty artwork slots of games with no Steam match; art you set is never replaced. Get a free key in your SteamGridDB profile preferences.",
};

export function MetadataSection() {
    const ctx = usePanelContext();
    const [services, setServices] = useSetting("services");
    const [status, setStatus] = useState<ProviderStatus | null>(null);
    const [showAddModal, setShowAddModal] = useState(false);

    // Form inputs in modal
    const [selectedService, setSelectedService] =
        useState<MetadataServiceId>("steam_store");
    const [ssUser, setSsUser] = useState("");
    const [ssPass, setSsPass] = useState("");
    const [igdbId, setIgdbId] = useState("");
    const [igdbSecret, setIgdbSecret] = useState("");
    const [sgdbKey, setSgdbKey] = useState("");

    const [statusMsg, setStatusMsg] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    const refresh = () => {
        backend
            .getStatus()
            .then(setStatus)
            .catch(() => {});
    };

    useEffect(() => {
        refresh();
    }, []);

    // Determine active services
    const activeServices: MetadataServiceDef[] = [];
    const [steamStoreService, ssService, igdbService, sgdbService] =
        ALL_METADATA_SERVICES;
    if (steamStoreService && services.steamStoreEnabled !== false) {
        activeServices.push(steamStoreService);
    }
    if (
        ssService &&
        services.screenscraperEnabled !== false &&
        status?.has_screenscraper
    ) {
        activeServices.push(ssService);
    }
    if (igdbService && services.igdbEnabled !== false && status?.has_twitch) {
        activeServices.push(igdbService);
    }
    if (
        sgdbService &&
        services.steamgriddbEnabled !== false &&
        status?.has_sgdb
    ) {
        activeServices.push(sgdbService);
    }

    const availableToAdd = ALL_METADATA_SERVICES.filter(
        (s) => !activeServices.some((active) => active.id === s.id),
    );

    const handleRemoveService = (id: MetadataServiceId) => {
        if (id === "steam_store") {
            setServices({ ...services, steamStoreEnabled: false });
        } else if (id === "screenscraper") {
            setServices({ ...services, screenscraperEnabled: false });
        } else if (id === "igdb") {
            setServices({ ...services, igdbEnabled: false });
        } else if (id === "steamgriddb") {
            setServices({ ...services, steamgriddbEnabled: false });
        }
        ctx.ingest.trigger(250);
    };

    const handleOpenAddModal = () => {
        const first = availableToAdd[0];
        if (first) {
            setSelectedService(first.id);
            setStatusMsg("");
            setShowAddModal(true);
        }
    };

    /** Closes the Add popup and forgets what was typed (a connected account keeps its popup open until this). */
    const closeAddModal = () => {
        setShowAddModal(false);
        setIsSaving(false);
        setStatusMsg("");
        setSsPass("");
        setIgdbSecret("");
        setSgdbKey("");
    };

    const handleRegisterService = async () => {
        setIsSaving(true);
        setStatusMsg("Saving...");

        if (selectedService === "steam_store") {
            setServices({ ...services, steamStoreEnabled: true });
            ctx.ingest.trigger(250);
            setStatusMsg("✓ Steam Store Mirror added");
            setTimeout(() => {
                setShowAddModal(false);
                setIsSaving(false);
                setStatusMsg("");
            }, 1000);
            return;
        }

        if (selectedService === "screenscraper") {
            if (!ssUser.trim() || !ssPass.trim()) {
                setStatusMsg("Username and password are required.");
                setIsSaving(false);
                return;
            }
            setStatusMsg("Checking the account...");
            const res = await saveAndCheck("screenscraper", "ScreenScraper", {
                screenscraper_user: ssUser.trim(),
                screenscraper_pass: ssPass.trim(),
            });
            if (res.ok) {
                setServices({ ...services, screenscraperEnabled: true });
                ctx.ingest.trigger(250);
            }
            refresh();
            setStatusMsg(res.message);
            if (!res.ok) setIsSaving(false);
            return;
        }

        if (selectedService === "igdb") {
            if (!igdbId.trim() || !igdbSecret.trim()) {
                setStatusMsg("Client ID and Secret are required.");
                setIsSaving(false);
                return;
            }
            setStatusMsg("Checking the account...");
            const res = await saveAndCheck("igdb", "IGDB", {
                twitch_client_id: igdbId.trim(),
                twitch_client_secret: igdbSecret.trim(),
            });
            if (res.ok) {
                setServices({ ...services, igdbEnabled: true });
                ctx.ingest.trigger(250);
            }
            refresh();
            setStatusMsg(res.message);
            if (!res.ok) setIsSaving(false);
            return;
        }

        if (selectedService === "steamgriddb") {
            if (!sgdbKey.trim()) {
                setStatusMsg("An API key is required.");
                setIsSaving(false);
                return;
            }
            setStatusMsg("Checking the account...");
            const res = await saveAndCheck("steamgriddb", "SteamGridDB", { steamgriddb_api: sgdbKey.trim() });
            if (res.ok) {
                setServices({ ...services, steamgriddbEnabled: true });
                ctx.ingest.trigger(250);
            }
            refresh();
            setStatusMsg(res.message);
            if (!res.ok) setIsSaving(false);
            return;
        }
    };

    return (
        <PanelSection title="Metadata">
            <Blocks>
                {activeServices.length > 0 && (
                    <>
                        {activeServices.map((svc) => (
                            <ItemRow key={svc.id}>
                                <Field label={svc.label}>
                                    <IconButton onClick={() => handleRemoveService(svc.id)} title="Remove">
                                        🗑️
                                    </IconButton>
                                </Field>
                            </ItemRow>
                        ))}
                    </>
                )}
                {availableToAdd.length > 0 && (
                    <ButtonRow
                        label="Add service"
                        description="Connect another source of game info and artwork"
                        buttonLabel="Add"
                        onClick={handleOpenAddModal}
                    />
                )}
            </Blocks>

            {/* Add Service popup: the same rows and spacing as the panel. */}
            <SettingsModal title="Add Metadata Service" isOpen={showAddModal} onClose={closeAddModal}>
                <PanelSection>
                    <Blocks>
                        <FullWidthRows label="Service" description={SERVICE_DESCRIPTIONS[selectedService]}>
                            <Dropdown
                                rgOptions={availableToAdd.map((s) => ({ data: s.id, label: s.label }))}
                                selectedOption={selectedService}
                                onChange={(o) => setSelectedService(o.data as MetadataServiceId)}
                                contextMenuPositionOptions={{ bMatchWidth: true }}
                            />
                        </FullWidthRows>
                        {selectedService === "screenscraper" && (
                            <>
                                <ItemRow trailing>
                                    <TextField label="Username" value={ssUser} onChange={(e) => setSsUser(e.target.value)} />
                                </ItemRow>
                                <ItemRow trailing>
                                    <TextField label="Password" bIsPassword value={ssPass} onChange={(e) => setSsPass(e.target.value)} />
                                </ItemRow>
                                <CredentialsNote service="ScreenScraper" />
                            </>
                        )}
                        {selectedService === "igdb" && (
                            <>
                                <ItemRow trailing>
                                    <TextField label="Twitch Client ID" value={igdbId} onChange={(e) => setIgdbId(e.target.value)} />
                                </ItemRow>
                                <ItemRow trailing>
                                    <TextField
                                        label="Twitch Client Secret"
                                        bIsPassword
                                        value={igdbSecret}
                                        onChange={(e) => setIgdbSecret(e.target.value)}
                                    />
                                </ItemRow>
                                <CredentialsNote service="Twitch and IGDB" />
                            </>
                        )}
                        {selectedService === "steamgriddb" && (
                            <>
                                <ItemRow trailing>
                                    <TextField label="API Key" bIsPassword value={sgdbKey} onChange={(e) => setSgdbKey(e.target.value)} />
                                </ItemRow>
                                <CredentialsNote service="SteamGridDB" />
                            </>
                        )}
                        <ActionRow message={statusMsg}>
                            {!statusMsg.startsWith("✓") && (
                                <DialogButton disabled={isSaving} onClick={handleRegisterService} style={BUTTON_STYLE}>
                                    Add
                                </DialogButton>
                            )}
                            <DialogButton onClick={closeAddModal} style={BUTTON_STYLE}>
                                {statusMsg.startsWith("✓") ? "Close" : "Cancel"}
                            </DialogButton>
                        </ActionRow>
                    </Blocks>
                </PanelSection>
            </SettingsModal>
        </PanelSection>
    );
}
