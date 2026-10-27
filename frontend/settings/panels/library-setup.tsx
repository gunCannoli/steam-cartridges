// Settings: the Library Setup block, first in the panel (ADR-0086, plan § 5 and § 7). Before setup it says that nothing is
// fetched yet and opens the setup window; afterwards it says how many games wait for the user ("3 new games to review") and
// opens the games list. There is no Refresh library button: opening the panel already reads the library, and a game cannot
// be added while the panel is open. It never fetches an unanswered game on its own.
import { useEffect, useRef, useState } from "react";
import { PanelSection } from "@steambrew/client";
import { Blocks, ButtonRow, StatRow } from "../components";
import { usePanelContext } from "../context";
import { onLibraryChanged } from "../library-events";
import { LibrarySetupWindow } from "../setup/setup-window";
import { UPGRADE_SCALE, UpgradeOnboardingWindow } from "../setup/upgrade-window";
import { waitingCounts, waitingTotal } from "../../domain/library-setup";

/** The setup window's share of the screen (plan Q4: 60%, tuned after the first look). */
const SETUP_SCALE = 0.6;

/** The window opens by itself the first time the panel is entered in a Steam session while onboarding is not done (plan § 3b). */
let autoOpened = false;
/** The "new onboarding" prompt (ADR-0093) is asked once per Steam session; the answer is stored, so it is not asked again. */
let promptOpened = false;

/** `onOnboarded`: told whenever the state is read, so the panel can grey the other sections out until onboarding is done. */
export function LibrarySetupSection({ onOnboarded }: { onOnboarded?: (onboarded: boolean | undefined) => void } = {}) {
    const ctx = usePanelContext();
    const anchor = useRef<HTMLSpanElement>(null);
    const [done, setDone] = useState<boolean | undefined>();
    const [onboarded, setOnboarded] = useState<boolean | undefined>();
    const [upgrade, setUpgrade] = useState<boolean | undefined>();
    const [waiting, setWaiting] = useState(0);

    // The state and the waiting games are read again once the window closes. The scan is offline and cheap (plan § 6).
    const read = () => {
        void ctx.setup.isDone().then(setDone);
        void ctx.setup.state().then((st) => {
            setOnboarded(st?.onboarded);
            setUpgrade(st?.upgrade);
            onOnboarded?.(st?.onboarded);
        });
        void ctx.setup
            .scan()
            // Only the games the rules put in scope wait for the user: the others are left alone (ADR-0089).
            .then((res) => setWaiting(res.error ? 0 : waitingTotal(waitingCounts(res.games.filter((g) => ctx.routing.serviceAllowed("all", g.appid))))))
            .catch(() => setWaiting(0));
    };
    useEffect(read, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => onLibraryChanged(read), []); // eslint-disable-line react-hooks/exhaustive-deps
    // The state alone (one small call) is read again every few seconds: a window this panel did not open can change it.
    useEffect(() => {
        const t = setInterval(() => {
            void ctx.setup.state().then((st) => {
                setOnboarded(st?.onboarded);
                onOnboarded?.(st?.onboarded);
            });
        }, 3000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Its own window, over the one the user clicked in (ctx.dialog).
    const open = (startStep: number, refresh = false) => (e?: { currentTarget?: unknown }) => {
        const from = (e?.currentTarget as Element | undefined)?.ownerDocument?.defaultView ?? undefined;
        ctx.dialog.open(<LibrarySetupWindow startStep={startStep} refresh={refresh} />, "Library Setup", read, from, SETUP_SCALE);
    };

    // An update that brings a new onboarding asks first (a small window); otherwise a library not onboarded opens the onboarding.
    useEffect(() => {
        const from = anchor.current?.ownerDocument?.defaultView ?? undefined;
        if (upgrade === true) {
            if (promptOpened) return;
            promptOpened = true;
            ctx.dialog.open(<UpgradeOnboardingWindow onDone={read} />, "New onboarding", read, from, UPGRADE_SCALE);
            return;
        }
        if (upgrade === undefined || onboarded !== false || autoOpened) return;
        autoOpened = true;
        ctx.dialog.open(<LibrarySetupWindow startStep={0} />, "Library Setup", read, from, SETUP_SCALE);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onboarded, upgrade]);

    return (
        <PanelSection title="Library Setup">
            <span ref={anchor} style={{ display: "none" }} />
            <Blocks>
                {onboarded === false ? (
                    <ButtonRow
                        label="Onboarding required"
                        description="Explains the plugin and sets the rules for your library. Nothing new is fetched until you finish it or skip it, and the other settings wait."
                        buttonLabel="Open"
                        onClick={open(0)}
                    />
                ) : done === false ? (
                    <ButtonRow
                        label="Set up your library"
                        description="Nothing is fetched for your non-Steam games until you run it: pick your sources, then confirm each game the plugin detects."
                        buttonLabel="Start"
                        onClick={open(0)}
                    />
                ) : (
                    // An array, not a fragment: Blocks spaces its children, a fragment would be one block.
                    [
                        // One block: the count, then the two buttons (rows touch inside a block).
                        <div key="status">
                            <StatRow label="Games to set up" value={waiting} warn />
                            <ButtonRow label="Review your games" description="Confirm or change each game's answer." buttonLabel="Open" onClick={open(3)} />
                        </div>,
                    ]
                )}
            </Blocks>
        </PanelSection>
    );
}
