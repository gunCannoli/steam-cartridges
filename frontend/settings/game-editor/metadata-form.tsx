// Game Data editor: one text field per editable field, then the player tags and the controller support (features plan F1).
// Layout rules: docs/plugins.md § Settings panel layout (a row has two columns at most; a dropdown gets the full row).
import { Dropdown, Field, TextField } from "@steambrew/client";
import { EDITABLE_FIELDS, PLAYER_FLAGS, type MetadataDraft } from "../../domain/metadata-edit";
import { setSetting, useSetting, type ControllerOverride } from "../settings";
import { usePanelContext } from "../context";
import { ActionRow, Blocks, ButtonRow, CARD_BACKGROUND, FullWidthRows, ItemRow, ToggleRow } from "../components";
import { TEXTAREA_STYLE } from "./styles";

const CONTROLLER_OPTIONS: { data: ControllerOverride; label: string }[] = [
    { data: "auto", label: "Default / Auto" },
    { data: "full", label: "Full Controller Support" },
    { data: "partial", label: "Partial Controller Support" },
    { data: "none", label: "Keyboard & Mouse Only" },
];

export function MetadataForm({
    appid,
    draft,
    onChange,
    errors,
    dirty,
    custom,
    hasMetadata,
    busy,
    onSave,
    onRevert,
    onNotice,
}: {
    appid: number;
    draft: MetadataDraft;
    onChange: (next: MetadataDraft) => void;
    errors: string[];
    dirty: boolean;
    custom: boolean;
    hasMetadata: boolean;
    busy: boolean;
    onSave: () => void;
    onRevert: () => void;
    onNotice: (text: string) => void;
}) {
    const ctx = usePanelContext();
    const [overrides] = useSetting("controllerOverrides");
    const override = overrides[String(appid)] ?? "auto";
    const detected = ctx.controller.inferredFor(appid);

    const setController = (next: ControllerOverride) => {
        // Written before Game Info re-derives its badges, so the change shows at once.
        void setSetting("controllerOverrides", { ...overrides, [String(appid)]: next }).then(() => {
            ctx.controller.refresh(appid);
            onNotice("Controller support updated.");
        });
    };

    return (
        <Blocks>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                <ItemRow>
                    <Field
                        label="Game Details"
                        description={
                            !hasMetadata
                                ? "No data fetched yet. Fill in details below. Separate multiple entries with semicolons (;). Dates use YYYY-MM-DD format."
                                : "Separate multiple entries with semicolons (;). Dates use YYYY-MM-DD format."
                        }
                        bottomSeparator="none"
                    />
                </ItemRow>
                {EDITABLE_FIELDS.map((f) =>
                    f.kind === "textarea" ? (
                        <ItemRow key={f.key}>
                            <Field label={f.label} childrenLayout="below" childrenContainerWidth="max">
                                <textarea rows={5} value={draft[f.key]} onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })} style={TEXTAREA_STYLE} />
                            </Field>
                        </ItemRow>
                    ) : (
                        <ItemRow key={f.key} trailing>
                            <TextField
                                label={f.label}
                                value={draft[f.key]}
                                onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })}
                            />
                        </ItemRow>
                    ),
                )}
                {errors.length > 0 && <ActionRow message={errors[0]} />}
            </div>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                {PLAYER_FLAGS.map((p) => (
                    <ToggleRow
                        key={p.flag}
                        label={p.label}
                        description={p.flag === "single_player" ? "Tags shown in Game Info" : undefined}
                        value={draft.players[p.flag]}
                        onChange={(on) => onChange({ ...draft, players: { ...draft.players, [p.flag]: on } })}
                    />
                ))}
            </div>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                <FullWidthRows
                    label="Controller support"
                    description={
                        detected === true
                            ? "Detected: full controller support"
                            : detected === false
                              ? "Detected: keyboard & mouse"
                              : "Auto-detected based on platform/core"
                    }
                >
                    <Dropdown
                        rgOptions={CONTROLLER_OPTIONS}
                        selectedOption={override}
                        contextMenuPositionOptions={{ bMatchWidth: true }}
                        onChange={(o) => setController(o.data as ControllerOverride)}
                    />
                </FullWidthRows>
            </div>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                <ButtonRow label="Save" description="Saves changes as a protected manual edit" buttonLabel="Save" disabled={busy || !dirty || errors.length > 0} onClick={onSave} />
                <ButtonRow
                    label="Revert to fetched data"
                    description={custom ? "Restore original fetched metadata" : "No manual edit to revert"}
                    buttonLabel="Revert"
                    disabled={busy || !custom}
                    onClick={onRevert}
                />
            </div>
        </Blocks>
    );
}
