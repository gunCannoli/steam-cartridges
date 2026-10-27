// Game Data editor: the game's details as three cards (features plan F1; layout ADR-0076): the Game Info fields with
// Save / Revert, the player tags, and the controller support. Layout rules: docs/plugins.md guardrail 18 (a text field
// gets its own full row, its note is its description; flags are toggle rows; a dropdown gets the full row).
import { Dropdown, Field } from "@steambrew/client";
import { EDITABLE_FIELDS, PLAYER_FLAGS, type MetadataDraft } from "../../domain/metadata-edit";
import type { IssueKey } from "../../domain/game-issues";
import { setSetting, useSetting, type ControllerOverride } from "../settings";
import { usePanelContext } from "../context";
import { ActionRow, ButtonRow, Card, FullWidthRows, ItemRow, TextRows, ToggleRow } from "../components";
import { TEXTAREA_STYLE, tint } from "./styles";
import { Missing } from "./missing";

const CONTROLLER_OPTIONS: { data: ControllerOverride; label: string }[] = [
    { data: "auto", label: "Default / Auto" },
    { data: "full", label: "Full Controller Support" },
    { data: "partial", label: "Partial Controller Support" },
    { data: "none", label: "Keyboard & Mouse Only" },
];

/** Each field's note: what it takes. */
const NOTES: Record<string, string> = {
    list: "Separate entries with semicolons (;)",
    date: "YYYY-MM-DD",
};

export function DetailsCard({
    draft,
    onChange,
    errors,
    dirty,
    custom,
    linked,
    hasMetadata,
    busy,
    onSave,
    onRevert,
    missing,
    status,
}: {
    draft: MetadataDraft;
    onChange: (next: MetadataDraft) => void;
    errors: string[];
    dirty: boolean;
    custom: boolean;
    /** The source the Game Info is linked to ("IGDB", "ScreenScraper"), if any: Revert then unlinks it (ADR-0087). */
    linked?: string;
    hasMetadata: boolean;
    busy: boolean;
    onSave: () => void;
    onRevert: () => void;
    /** The game's issues (ADR-0076): their fields are tinted until they have a value. */
    missing: ReadonlySet<IssueKey>;
    /** This card's action status (Save / Revert), shown as its last row. */
    status?: string;
}) {
    const missingField = (key: string) => missing.has(key as IssueKey) && String(draft[key as keyof MetadataDraft] ?? "").trim() === "";

    return (
        <Card>
            <ItemRow>
                <Field
                    label="Game Info"
                    description={hasMetadata ? "What Steam's Game Info shows. Saved as your own edit, which no source replaces." : "Nothing fetched yet: fill it in."}
                    bottomSeparator="none"
                />
            </ItemRow>
            {EDITABLE_FIELDS.map((f) => (
                <Missing key={f.key} on={missingField(f.key)}>
                    {f.kind === "textarea" ? (
                        <ItemRow>
                            <Field label={f.label} childrenLayout="below" childrenContainerWidth="max" bottomSeparator="none">
                                <textarea rows={6} value={draft[f.key]} onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })} style={TEXTAREA_STYLE} />
                            </Field>
                        </ItemRow>
                    ) : (
                        <TextRows label={f.label} description={NOTES[f.kind]} value={draft[f.key]} onChange={(v) => onChange({ ...draft, [f.key]: v })} />
                    )}
                </Missing>
            ))}
            {errors.length > 0 && <ActionRow message={errors[0]} />}
            <ButtonRow label="Save" description="Saves your changes as your own edit" buttonLabel="Save" disabled={busy || !dirty || errors.length > 0} onClick={onSave} />
            <ButtonRow
                label="Revert to fetched data"
                description={
                    custom
                        ? linked
                            ? `Drops your edit and shows the linked ${linked} game's data`
                            : "Drops your edit and shows what the sources give"
                        : linked
                          ? `Unlinks the ${linked} game: the game is looked up by its name again`
                          : "No edit of yours to revert"
                }
                buttonLabel="Revert"
                disabled={busy || !(custom || linked)}
                onClick={onRevert}
            />
            {status && <ActionRow message={status} />}
        </Card>
    );
}

export function PlayersCard({ draft, onChange }: { draft: MetadataDraft; onChange: (next: MetadataDraft) => void }) {
    return (
        <Card>
            <ItemRow>
                <Field label="Players" description="The player tags of Game Info (saved with Game Info)" bottomSeparator="none" />
            </ItemRow>
            {PLAYER_FLAGS.map((p) => (
                <ToggleRow key={p.flag} label={p.label} value={draft.players[p.flag]} onChange={(on) => onChange({ ...draft, players: { ...draft.players, [p.flag]: on } })} />
            ))}
        </Card>
    );
}

export function ControllerCard({ appid, missing, onNotice }: { appid: number; missing: boolean; onNotice: (text: string) => void }) {
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
        <Card style={tint(missing && override === "auto")}>
            <Missing on={missing && override === "auto"}>
            <FullWidthRows
                label="Controller support"
                description={
                    detected === true
                        ? "Detected: full controller support. Applied at once."
                        : detected === false
                          ? "Detected: keyboard & mouse. Applied at once."
                          : "Not detected from the emulator or the game's platforms. Applied at once."
                }
            >
                <Dropdown
                    rgOptions={CONTROLLER_OPTIONS}
                    selectedOption={override}
                    contextMenuPositionOptions={{ bMatchWidth: true }}
                    onChange={(o) => setController(o.data as ControllerOverride)}
                />
            </FullWidthRows>
            </Missing>
        </Card>
    );
}
