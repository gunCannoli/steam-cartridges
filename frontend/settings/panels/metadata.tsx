// Settings: Metadata sources. The sources in use and "Add source"; the Add popup is its own window (add-service.tsx).
import { useEffect, useState } from "react";
import { Field, PanelSection } from "@steambrew/client";
import { useSetting } from "../settings";
import { backend, type ProviderStatus } from "../../ports/backend";
import { usePanelContext } from "../context";
import { Blocks, ButtonRow, IconButton, ItemRow } from "../components";
import { ADD_SERVICE_SCALE, AddServiceWindow, type Addable } from "./add-service";

type MetadataServiceId = "steam_store" | "screenscraper" | "igdb" | "steamgriddb";

interface MetadataServiceDef extends Addable {
    id: MetadataServiceId;
}

// The Steam mirror first: it needs no setup.
const ALL_METADATA_SERVICES: MetadataServiceDef[] = [
    { id: "steam_store", label: "Steam Store Mirror" },
    { id: "screenscraper", label: "ScreenScraper" },
    { id: "igdb", label: "IGDB" },
    { id: "steamgriddb", label: "SteamGridDB" },
];

export function MetadataSection() {
    const ctx = usePanelContext();
    const [services, setServices] = useSetting("services");
    const [status, setStatus] = useState<ProviderStatus | null>(null);

    const refresh = () => {
        backend
            .getStatus()
            .then(setStatus)
            .catch(() => {});
    };

    useEffect(() => {
        refresh();
    }, []);

    // A service is in use when it is on and, if it needs a key, has one. Nothing is on until the user adds it.
    const isActive = (id: MetadataServiceId): boolean => {
        if (id === "steam_store") return services.steamStoreEnabled === true;
        if (id === "screenscraper") return services.screenscraperEnabled === true && !!status?.has_screenscraper;
        if (id === "igdb") return services.igdbEnabled === true && !!status?.has_twitch;
        return services.steamgriddbEnabled === true && !!status?.has_sgdb;
    };
    const activeServices = ALL_METADATA_SERVICES.filter((s) => isActive(s.id));
    const availableToAdd = ALL_METADATA_SERVICES.filter((s) => !isActive(s.id));

    const handleRemoveService = (id: MetadataServiceId) => {
        if (id === "steam_store") setServices({ ...services, steamStoreEnabled: false });
        else if (id === "screenscraper") setServices({ ...services, screenscraperEnabled: false });
        else if (id === "igdb") setServices({ ...services, igdbEnabled: false });
        else setServices({ ...services, steamgriddbEnabled: false });
        ctx.ingest.trigger(250);
    };

    const openAdd = (e?: { currentTarget?: unknown }) => {
        const from = (e?.currentTarget as Element | undefined)?.ownerDocument?.defaultView ?? undefined;
        ctx.dialog.open(<AddServiceWindow title="Add Metadata Source" options={availableToAdd} onAdded={refresh} />, "Add Metadata Source", refresh, from, ADD_SERVICE_SCALE);
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
                        label="Add source"
                        description="Connect a source of game info and artwork"
                        buttonLabel="Add"
                        onClick={openAdd as () => void}
                    />
                )}
            </Blocks>
        </PanelSection>
    );
}
