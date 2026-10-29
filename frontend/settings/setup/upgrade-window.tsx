// The "new onboarding" prompt (ADR-0093): shown once, the first time the settings panel is opened after an update that brings a new
// onboarding. A small window of its own. The user chooses what to keep, then runs the onboarding or skips it. Nothing is
// deleted: what is cleared is moved into a backup folder in the plugin's data folder.
import { useRef, useState } from "react";
import { DialogButton, Field, PanelSection } from "@steambrew/client";
import { ActionRow, Blocks, BUTTON_STYLE, Card, ItemRow, ToggleRow, WindowFrame } from "../components";
import { usePanelContext } from "../context";
import { backend } from "../../ports/backend";
import { LibrarySetupWindow } from "./setup-window";

/** The prompt's share of the screen: a small window (steam/modal.ts gives scales under 0.5 a 700 x 480 floor). */
export const UPGRADE_SCALE = 0.3;
/** The onboarding window's share of the screen (the same as the Library Setup block opens it with). */
const SETUP_SCALE = 0.6;

export function UpgradeOnboardingWindow({ onDone, closeModal }: { onDone?: () => void; closeModal?: () => void }) {
    const ctx = usePanelContext();
    const anchor = useRef<HTMLSpanElement>(null);
    // Start from zero keeps nothing: it switches the three keep options off and disables them; they are on by default.
    const [zero, setZero] = useState(false);
    const [keepCredentials, setKeepCredentials] = useState(true);
    const [keepSettings, setKeepSettings] = useState(true);
    const [keepMetadata, setKeepMetadata] = useState(true);
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);

    const run = async () => {
        setBusy(true);
        setMsg("Preparing...");
        try {
            const keep = { credentials: keepCredentials && !zero, settings: keepSettings && !zero, metadata: keepMetadata && !zero };
            await ctx.setup.startOver({
                zero: zero || !keep.credentials || !keep.settings || !keep.metadata,
                keepCredentials: keep.credentials,
                keepSettings: keep.settings,
                keepMetadata: keep.metadata,
            });
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            backend.logEvent("onboarding", `start over failed: ${msg.slice(0, 120)}`);
            setMsg(msg);
            setBusy(false);
            return;
        }
        // The onboarding window opens over this one, then this one closes.
        const from = anchor.current?.ownerDocument?.defaultView ?? undefined;
        ctx.dialog.open(<LibrarySetupWindow startStep={0} />, "Library Setup", onDone, from, SETUP_SCALE);
        onDone?.();
        closeModal?.();
    };

    const skip = async () => {
        setBusy(true);
        try {
            await ctx.setup.skipUpgrade();
        } catch {
            backend.logEvent("onboarding", "skip answer failed; the prompt is asked again next time");
        }
        onDone?.();
        closeModal?.();
    };

    return (
        <WindowFrame
            footer={
                <ActionRow message={msg}>
                    <DialogButton disabled={busy} onClick={() => void run()} style={BUTTON_STYLE}>
                        Run onboarding
                    </DialogButton>
                    <DialogButton disabled={busy} onClick={() => void skip()} style={BUTTON_STYLE}>
                        Skip
                    </DialogButton>
                </ActionRow>
            }
        >
            <span ref={anchor} style={{ display: "none" }} />
            <PanelSection title="A new onboarding is available">
                <Blocks>
                    <Card>
                        <ItemRow>
                            <Field
                                label="Run it to set up the plugin again"
                                description="It walks you through your metadata sources, achievements and rules. Choose what to keep. Nothing is deleted: what is cleared is moved to a backup folder in the plugin's data folder."
                                bottomSeparator="none"
                            />
                        </ItemRow>
                    </Card>
                    <Card>
                        <ToggleRow label="Start from zero" description="Keeps nothing from the old setup: credentials, settings and games metadata are all cleared." value={zero} onChange={setZero} />
                        <ToggleRow label="Keep saved credentials" description="Your keys and accounts." value={keepCredentials && !zero} disabled={zero} onChange={setKeepCredentials} />
                        <ToggleRow label="Keep all settings" description="Sources, rules and every option." value={keepSettings && !zero} disabled={zero} onChange={setKeepSettings} />
                        <ToggleRow label="Keep games metadata" description="Game Info, achievements, confirmed games and downloaded media." value={keepMetadata && !zero} disabled={zero} onChange={setKeepMetadata} />
                    </Card>
                </Blocks>
            </PanelSection>
        </WindowFrame>
    );
}
