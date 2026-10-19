// Game Data editor: the text filter and the dropdown of every non-Steam shortcut (features plan F1).
// One card, like Reset Achievements in enhanced-notifications: the controls stack, each across the full row.
import { Dropdown, Field, TextField } from "@steambrew/client";
import { usePanelContext } from "../context";
import { CARD_BACKGROUND, CONTROL_GAP, ItemRow, STEAM_TRAILING } from "../components";

export function GamePicker({ filter, onFilter, appid, onPick }: { filter: string; onFilter: (text: string) => void; appid: number | undefined; onPick: (appid: number) => void }) {
    const shortcuts = usePanelContext().routing.listShortcuts();
    const needle = filter.trim().toLowerCase();
    const shown = needle ? shortcuts.filter((s) => s.name.toLowerCase().includes(needle)) : shortcuts;
    // Keep the chosen game selectable even when the filter hides it.
    const chosen = appid === undefined ? undefined : shortcuts.find((s) => s.appid === appid);
    const options = (chosen && !shown.includes(chosen) ? [chosen, ...shown] : shown).map((s) => ({ data: s.appid, label: s.name }));

    return (
        <ItemRow>
            <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden" }}>
                <Field
                    label="Choose Game"
                    description="Select a shortcut to view and edit its metadata"
                    bottomSeparator="none"
                />
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: CONTROL_GAP,
                        padding: "0 12px 12px",
                    }}
                >
                    <div style={{ marginBottom: -STEAM_TRAILING }}>
                        <TextField
                            label={`Games filter (${shown.length} of ${shortcuts.length})`}
                            value={filter}
                            onChange={(e) => onFilter(e.target.value)}
                        />
                    </div>
                    <Dropdown
                        rgOptions={options}
                        selectedOption={appid}
                        onChange={(o) => onPick(o.data as number)}
                        contextMenuPositionOptions={{ bMatchWidth: true }}
                        strDefaultLabel="Choose a game…"
                    />
                </div>
            </div>
        </ItemRow>
    );
}
