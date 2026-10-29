// The "Add source" window of the Metadata and Achievements sections. A popup that opens a dropdown is its own
// window (guardrail 18.8): an overlay inside another window ate clicks and the dropdown would not open (seen 2026-10-26).
import { useState } from "react";
import { DialogButton, Dropdown, PanelSection } from "@steambrew/client";
import { useSetting } from "../settings";
import { usePanelContext } from "../context";
import { ActionRow, Blocks, BUTTON_STYLE, CredentialsNote, FullWidthRows, TextRows, WindowFrame } from "../components";
import { saveAndCheck } from "../service-check";
import { backend } from "../../ports/backend";

/** The popup's share of the screen. */
export const ADD_SERVICE_SCALE = 0.3;

export type AddableId = "steam_store" | "screenscraper" | "igdb" | "steamgriddb" | "retroachievements" | "console_emulators" | "native_ports";

export interface Addable {
    id: AddableId;
    label: string;
}

/** What each service brings, shown under the dropdown. The Steam mirror needs no key, so it is the first of the list. */
export const DESCRIPTIONS: Record<AddableId, string> = {
    steam_store: "Steam's own info for a non-Steam game that has a Steam counterpart. No key needed.",
    screenscraper: "Game Info, screenshots, artwork and manuals for retro games. Sign in with your screenscraper.fr account.",
    igdb: "Game Info, trailers and artwork. Needs a Twitch developer app's Client ID and Secret.",
    steamgriddb: "Fills empty artwork slots of games with no Steam match; art you set is never replaced. Get a free key in your SteamGridDB profile preferences.",
    retroachievements: "Your RetroAchievements unlocks. Sign in with your username and Web API key.",
    native_ports: "Native PC ports that write their own trophy files: Bloodborne PC and Dusklight. Nothing to set up.",
    console_emulators: "Reads PS3 / PS4 trophies (RPCS3, shadPS4, Bloodborne PC) and DuckStation, PCSX2, Dolphin, PPSSPP and RPCS3 logs.",
};

export function AddServiceWindow({ title, options, onAdded, closeModal }: { title: string; options: Addable[]; onAdded?: () => void; closeModal?: () => void }) {
    const ctx = usePanelContext();
    const [services, setServices] = useSetting("services");
    const [selected, setSelected] = useState<AddableId>(options[0]?.id ?? "steam_store");
    const [ssUser, setSsUser] = useState("");
    const [ssPass, setSsPass] = useState("");
    const [igdbId, setIgdbId] = useState("");
    const [igdbSecret, setIgdbSecret] = useState("");
    const [sgdbKey, setSgdbKey] = useState("");
    const [raUser, setRaUser] = useState("");
    const [raToken, setRaToken] = useState("");
    const [msg, setMsg] = useState("");
    const [saving, setSaving] = useState(false);

    const done = (text: string) => {
        backend.logEvent("sources", `${selected} added`);
        setMsg(`✓ ${text}`);
        ctx.ingest.trigger(250, "services");
        onAdded?.(); // the opener re-reads, so the source leaves its list of what can still be added
    };
    const fail = (text: string) => {
        setMsg(text);
        backend.logEvent("sources", `${selected} add failed: ${text.slice(0, 120)}`);
        setSaving(false);
    };

    const add = async () => {
        setSaving(true);
        setMsg("Saving...");
        if (selected === "steam_store") {
            setServices({ ...services, steamStoreEnabled: true });
            return done("Steam Store Mirror added");
        }
        if (selected === "console_emulators") {
            setServices({ ...services, emulatorsEnabled: true, rpcs3Enabled: true });
            return done("Emulators added");
        }
        if (selected === "native_ports") {
            setServices({ ...services, nativePortsEnabled: true });
            return done("Native ports added");
        }
        if (selected === "screenscraper") {
            if (!ssUser.trim() || !ssPass.trim()) return fail("Username and password are required.");
            setMsg("Checking the account...");
            const res = await saveAndCheck("screenscraper", "ScreenScraper", { screenscraper_user: ssUser.trim(), screenscraper_pass: ssPass.trim() });
            if (res.ok) setServices({ ...services, screenscraperEnabled: true });
            return res.ok ? done(res.message.replace(/^✓\s*/, "")) : fail(res.message);
        }
        if (selected === "igdb") {
            if (!igdbId.trim() || !igdbSecret.trim()) return fail("Client ID and Secret are required.");
            setMsg("Checking the account...");
            const res = await saveAndCheck("igdb", "IGDB", { twitch_client_id: igdbId.trim(), twitch_client_secret: igdbSecret.trim() });
            if (res.ok) setServices({ ...services, igdbEnabled: true });
            return res.ok ? done(res.message.replace(/^✓\s*/, "")) : fail(res.message);
        }
        if (selected === "steamgriddb") {
            if (!sgdbKey.trim()) return fail("An API key is required.");
            setMsg("Checking the account...");
            const res = await saveAndCheck("steamgriddb", "SteamGridDB", { steamgriddb_api: sgdbKey.trim() });
            if (res.ok) setServices({ ...services, steamgriddbEnabled: true });
            return res.ok ? done(res.message.replace(/^✓\s*/, "")) : fail(res.message);
        }
        if (selected === "retroachievements") {
            if (!raUser.trim() || !raToken.trim()) return fail("Username and API token are required.");
            setMsg("Checking the account...");
            const res = await saveAndCheck("retroachievements", "RetroAchievements", { retroachievements_user: raUser.trim(), retroachievements_api: raToken.trim() });
            if (res.ok) setServices({ ...services, retroachievementsEnabled: true });
            return res.ok ? done(res.message.replace(/^✓\s*/, "")) : fail(res.message);
        }
    };

    const finished = msg.startsWith("✓");
    return (
        <WindowFrame
            footer={
                <ActionRow message={msg}>
                    {!finished && (
                        <DialogButton disabled={saving} onClick={() => void add()} style={BUTTON_STYLE}>
                            Add
                        </DialogButton>
                    )}
                    <DialogButton onClick={() => closeModal?.()} style={BUTTON_STYLE}>
                        {finished ? "Close" : "Cancel"}
                    </DialogButton>
                </ActionRow>
            }
        >
            <PanelSection title={title}>
                <Blocks>
                    <FullWidthRows label="Source" description={DESCRIPTIONS[selected]}>
                        <Dropdown
                            rgOptions={options.map((s) => ({ data: s.id, label: s.label }))}
                            selectedOption={selected}
                            onChange={(o) => {
                                setSelected(o.data as AddableId);
                                setMsg("");
                                setSaving(false);
                            }}
                            contextMenuPositionOptions={{ bMatchWidth: true }}
                        />
                    </FullWidthRows>
                    {selected === "screenscraper" && (
                        <div>
                            <TextRows label="Username" value={ssUser} onChange={setSsUser} />
                            <TextRows label="Password" password value={ssPass} onChange={setSsPass} />
                            <CredentialsNote service="ScreenScraper" />
                        </div>
                    )}
                    {selected === "igdb" && (
                        <div>
                            <TextRows label="Twitch Client ID" value={igdbId} onChange={setIgdbId} />
                            <TextRows label="Twitch Client Secret" password value={igdbSecret} onChange={setIgdbSecret} />
                            <CredentialsNote service="Twitch and IGDB" />
                        </div>
                    )}
                    {selected === "steamgriddb" && (
                        <div>
                            <TextRows label="API Key" password value={sgdbKey} onChange={setSgdbKey} />
                            <CredentialsNote service="SteamGridDB" />
                        </div>
                    )}
                    {selected === "retroachievements" && (
                        <div>
                            <TextRows label="Username" value={raUser} onChange={setRaUser} />
                            <TextRows label="Web API Key" password value={raToken} onChange={setRaToken} />
                            <CredentialsNote service="RetroAchievements" />
                        </div>
                    )}
                </Blocks>
            </PanelSection>
        </WindowFrame>
    );
}
