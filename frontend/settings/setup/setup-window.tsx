// Library Setup window (ADR-0086, plan § 7): its own window at 60% of the screen (Q4), the steps along the top, one step
// at a time. Steps 1-3 are the settings panel's own sections (the window composes them, it does not copy them); step 4
// is the list of games the user validates (step-games.tsx). Opened by the Library Setup block (panels/library-setup.tsx)
// through ctx.dialog. Nothing is fetched until the user detects or validates a game in step 4.
//
// Onboarding (ADR-0088): until the user finishes or skips, Next needs one source on. Step 4 lists only the games
// the rules put in scope (onboarding and later alike; Refresh library is the exception and shows every game).
import { useEffect, useMemo, useState } from "react";
import { DialogButton, Field, PanelSection } from "@steambrew/client";
import { ActionRow, BLOCK_GAP, Blocks, BUTTON_STYLE, Card, COLUMN_STYLE, CONTROL_GAP, ItemRow, SettingsModal } from "../components";
import { MetadataSection } from "../panels/metadata";
import { AchievementsSection } from "../panels/achievements";
import { RulesSection } from "../panels/rules";
import { usePanelContext } from "../context";
import { onSettingChange, useSetting } from "../settings";
import { backend, type ProviderStatus, type SetupGame } from "../../ports/backend";
import { inScopeCount, nextBlockedReason, pendingInScope, reachableStep, sourcesOn } from "../../domain/onboarding";
import { GamesStep } from "./step-games";
import { ScanWarning, StepIntro } from "./step-intro";
import { SETUP_STEPS, Timeline } from "./timeline";

/** Buttons whose label stays on one line (a wrapped label made the confirmation's two buttons two rows tall). */
const NOWRAP_BUTTON = { ...BUTTON_STYLE, whiteSpace: "nowrap" } as const;

const HINTS = [
    "Where Game Info, artwork and media come from.",
    "How a game's achievements are found. A game with no match can be linked by hand in the Games step, or marked as having none.",
    "Which games the plugin may scan: only the games your rules allow.",
    "Detect proposes a game for each shortcut; you answer each one. Only the games you validate are fetched.",
];

export function LibrarySetupWindow({
    startStep = 0,
    refresh = false,
    closeModal,
}: {
    startStep?: number;
    /** Refresh library (plan § 7.5): step 4 looks up the games nobody answered yet on its own. */
    refresh?: boolean;
    closeModal?: () => void;
}) {
    const ctx = usePanelContext();
    const [services] = useSetting("services");
    const [rules] = useSetting("routingRules");
    const [status, setStatus] = useState<ProviderStatus | null>(null);
    const [onboarded, setOnboarded] = useState<boolean | undefined>();
    const [rows, setRows] = useState<SetupGame[]>([]);
    const [gamesPending, setGamesPending] = useState<number | undefined>();
    const [step, setStep] = useState(startStep);
    const [visited, setVisited] = useState<ReadonlySet<number>>(new Set([startStep]));
    const [closing, setClosing] = useState(false);
    const [confirmSkip, setConfirmSkip] = useState(false);

    const readLibrary = () => {
        void ctx.setup
            .scan()
            .then((res) => !res.error && setRows(res.games))
            .catch(() => {});
    };

    // The keys a source needs (a source with none does not count as on), the onboarding flag and the library, read once.
    useEffect(() => {
        void backend.getStatus().then(setStatus).catch(() => {});
        void ctx.setup.isOnboarded().then(setOnboarded);
        readLibrary();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // The Rules step reads the library again: the answers may have changed in step 4.
    useEffect(() => {
        if (step === 2) readLibrary();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    const limited = onboarded === false;
    // Which games the rules put in scope, worked out once per change of the library or the rules: asking the routing for
    // every game on every render (a render per click, per keystroke) kept Steam's UI thread busy and swallowed clicks.
    const [scopeTick, setScopeTick] = useState(0);
    useEffect(() => onSettingChange((key) => key === "routingRules" && setScopeTick((n) => n + 1)), []);
    const scope = useMemo(() => {
        const set = new Set<number>();
        for (const r of rows) if (ctx.routing.serviceAllowed("all", r.appid)) set.add(r.appid);
        return set;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, rules, scopeTick]);
    const inScope = (appid: number) => scope.has(appid);
    const pending = pendingInScope(rows, inScope);
    const gate = { sourcesOn: limited ? sourcesOn(services, status) : 1, rules: rules.filter((r) => r.enabled !== false).length };
    const reach = limited ? reachableStep(gate) : SETUP_STEPS.length - 1;
    const reason = limited ? nextBlockedReason(step, gate) : undefined;
    const go = (next: number) => {
        if (next > reach) return;
        setVisited((v) => new Set([...v, next]));
        setStep(next);
        backend.logEvent("onboarding", `step ${next + 1} (${SETUP_STEPS[next]}) opened: sources on ${gate.sourcesOn}, rules ${gate.rules}, games ${rows.length}, in scope ${counts.inScope}`);
    };
    const last = step === SETUP_STEPS.length - 1;
    const counts = { detected: rows.length, inScope: inScopeCount(rows, inScope) };

    const finish = async (skipped: boolean) => {
        setClosing(true);
        backend.logEvent("onboarding", `${skipped ? "skipped" : "finished"} at step ${step + 1}: sources on ${gate.sourcesOn}, rules ${gate.rules}, games ${rows.length}, in scope ${counts.inScope}`);
        try {
            await ctx.setup.finish({ skipped, step: step + 1, pending: gamesPending ?? pending });
        } catch {
            /* the window still closes; the next start asks again */
        }
        closeModal?.();
    };

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                gap: BLOCK_GAP,
                height: "100vh",
                minHeight: 520,
                padding: BLOCK_GAP,
                boxSizing: "border-box",
                background: "#1b2838",
                color: "#dcdedf",
            }}
        >
            <Timeline step={step} visited={visited} reach={reach} onStep={go} />
            <div style={{ flex: 1, minHeight: 0, overflowY: last ? "hidden" : "auto", overflowX: "hidden" }}>
                {last ? (
                    <GamesStep
                        gateOnFind={limited && !refresh}
                        autoDetect={refresh}
                        scope={!refresh ? scope : undefined}
                        excluded={!refresh ? rows.length - counts.inScope : 0}
                        onPending={setGamesPending}
                    />
                ) : (
                    <div style={{ ...COLUMN_STYLE, maxWidth: 900, margin: "0 auto", gap: BLOCK_GAP }}>
                        <StepIntro step={step} counts={step === 2 ? counts : null} />
                        {step === 0 && <MetadataSection />}
                        {step === 1 && <AchievementsSection />}
                        {step === 2 && <RulesSection />}
                    </div>
                )}
            </div>
            <Card>
                <ItemRow>
                    <Field label={`${step + 1}. ${SETUP_STEPS[step]}`} description={HINTS[step]} bottomSeparator="none">
                        <div style={{ display: "flex", gap: CONTROL_GAP, alignItems: "center" }}>
                            {reason && <span style={{ color: "#e5a00d", fontSize: 12, maxWidth: 360, textAlign: "right" }}>{reason}</span>}
                            <DialogButton disabled={step === 0} onClick={() => go(step - 1)} style={BUTTON_STYLE}>
                                Back
                            </DialogButton>
                            {last ? (
                                <DialogButton disabled={closing} onClick={() => (limited ? void finish(false) : closeModal?.())} style={BUTTON_STYLE}>
                                    {limited ? "Finish" : "Close"}
                                </DialogButton>
                            ) : (
                                <DialogButton disabled={reason !== undefined || closing} onClick={() => go(step + 1)} style={BUTTON_STYLE}>
                                    Next
                                </DialogButton>
                            )}
                        </div>
                    </Field>
                </ItemRow>
                {step === 2 && counts.inScope > 0 && (
                    <div style={{ padding: "0 13px 13px" }}>
                        <ScanWarning games={counts.inScope} />
                    </div>
                )}
                {limited && step === 0 && (
                    <div style={{ padding: "0 16px 12px", textAlign: "right" }}>
                        <a
                            onClick={() => !closing && setConfirmSkip(true)}
                            style={{ cursor: "pointer", fontSize: 12, opacity: 0.7, textDecoration: "underline" }}
                        >
                            (I know what I'm doing, skip onboarding)
                        </a>
                    </div>
                )}
            </Card>
            {/* Skipping is allowed, but asked twice: the plugin has several options and onboarding shows them all. */}
            <SettingsModal title="Skip onboarding?" isOpen={confirmSkip} onClose={() => setConfirmSkip(false)} width="620px">
                <PanelSection>
                    <Blocks>
                        <ItemRow>
                            <Field
                                label="Are you sure?"
                                description="The plugin has several options, and onboarding is there to give you a full view of them. It is also quick to set up. If you skip, nothing is chosen for you and the plugin scans nothing until you add a rule in Settings."
                                bottomSeparator="none"
                            />
                        </ItemRow>
                        <ActionRow>
                            <DialogButton onClick={() => setConfirmSkip(false)} style={NOWRAP_BUTTON}>
                                Back to onboarding
                            </DialogButton>
                            <DialogButton
                                onClick={() => {
                                    setConfirmSkip(false);
                                    void finish(true);
                                }}
                                style={NOWRAP_BUTTON}
                            >
                                Skip anyway
                            </DialogButton>
                        </ActionRow>
                    </Blocks>
                </PanelSection>
            </SettingsModal>
        </div>
    );
}
