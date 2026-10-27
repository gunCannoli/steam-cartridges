// Library Setup window: the steps along the top (plan § 7.1). The current step is highlighted, a visited one shows a
// check, the others are dimmed and still clickable: the user may go back, or skip a step ("I will add a key later").
import { DialogButton } from "@steambrew/client";
import { CONTROL_GAP } from "../components";

export const SETUP_STEPS = ["Metadata", "Achievements", "Rules", "Games"] as const;

/** `reach`: the furthest step the user may open now (onboarding gates the steps after it). */
export function Timeline({ step, visited, reach, onStep }: { step: number; visited: ReadonlySet<number>; reach: number; onStep: (step: number) => void }) {
    return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: CONTROL_GAP, minWidth: 0 }}>
            {SETUP_STEPS.map((label, i) => {
                const current = i === step;
                const done = !current && visited.has(i);
                return (
                    <DialogButton
                        key={label}
                        disabled={i > reach}
                        onClick={() => onStep(i)}
                        style={{
                            flex: "1 1 160px",
                            minWidth: 0,
                            padding: "8px 12px",
                            textAlign: "left",
                            cursor: i > reach ? "not-allowed" : "pointer",
                            opacity: current || done ? 1 : i > reach ? 0.35 : 0.6,
                            background: current ? "rgba(26, 159, 255, 0.35)" : undefined,
                            borderBottom: current ? "3px solid #1a9fff" : "3px solid transparent",
                        }}
                    >
                        <span style={{ color: done ? "#a4d007" : undefined }}>{done ? "✓" : `${i + 1}`}</span>
                        {"  "}
                        {label}
                    </DialogButton>
                );
            })}
        </div>
    );
}
