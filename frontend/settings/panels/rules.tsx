// Settings: Routing Rules. The list of rules and one "Add rule"; the rule editor is its own window (rule-editor.tsx).
import { Field, PanelSection } from "@steambrew/client";
import { useSetting } from "../settings";
import { usePanelContext } from "../context";
import { backend } from "../../ports/backend";
import { Blocks, ButtonRow, CONTROL_GAP, IconButton, ItemRow } from "../components";
import { RuleEditorWindow } from "./rule-editor";

/** The editor window's share of the screen: the Library Setup window's (panels/library-setup.tsx SETUP_SCALE). */
const EDITOR_SCALE = 0.6;

export function RulesSection() {
    const ctx = usePanelContext();
    const [rules, setRules] = useSetting("routingRules");

    const openEditor = (index?: number) => (e?: { currentTarget?: unknown }) => {
        const from = (e?.currentTarget as Element | undefined)?.ownerDocument?.defaultView ?? undefined;
        ctx.dialog.open(<RuleEditorWindow index={index} />, index === undefined ? "Add rule" : "Edit rule", undefined, from, EDITOR_SCALE);
    };

    const handleDelete = (index: number) => {
        const gone = rules[index];
        const copy = [...rules];
        copy.splice(index, 1);
        setRules(copy);
        if (gone) backend.logEvent("rules", `deleted ${gone.action}/${gone.conditionType} (${copy.length} rules left)`);
        ctx.ingest.trigger(100, "rules");
    };

    return (
        <PanelSection title="Routing Rules">
            <Blocks>
                {rules.length > 0 && (
                    <>
                        {rules.map((rule, idx) => (
                            <ItemRow key={rule.id}>
                                <Field label={rule.name}>
                                    <div style={{ display: "flex", alignItems: "center", gap: CONTROL_GAP }}>
                                        <IconButton onClick={openEditor(idx) as () => void} title="Edit">
                                            ✏️
                                        </IconButton>
                                        <IconButton onClick={() => handleDelete(idx)} title="Remove">
                                            🗑️
                                        </IconButton>
                                    </div>
                                </Field>
                            </ItemRow>
                        ))}
                    </>
                )}
                <ButtonRow
                    label="Add rule"
                    description={rules.length === 0 ? "No rules yet: the plugin scans nothing until you add one." : undefined}
                    buttonLabel="Add"
                    onClick={openEditor()}
                />
            </Blocks>
        </PanelSection>
    );
}
