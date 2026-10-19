// Settings: Routing Rules (migration plan M8c, moved verbatim).
import { useState } from "react";
import { DialogButton, Dropdown, Field, PanelSection, TextField } from "@steambrew/client";
import { useSetting } from "../settings";
import { type RoutingRule, type ServiceTarget, type RuleAction, type ConditionType } from "../../domain/routing/policy";
import { usePanelContext } from "../context";
import { ActionRow, Blocks, BUTTON_STYLE, CONTROL_GAP, FullWidthRows, IconButton, ItemRow, SettingsModal, ToggleRow } from "../components";

// ===========================================================================
// 4. {Rules} Routing Engine Section
// ===========================================================================

const SERVICE_OPTIONS = [
    { data: "all", label: "All Services" },
    { data: "steam_store", label: "Steam Store Mirror" },
    { data: "retroachievements", label: "RetroAchievements" },
    { data: "console_emulators", label: "Console Emulators" },
    { data: "screenscraper", label: "ScreenScraper" },
    { data: "igdb", label: "IGDB" },
    { data: "steamgriddb", label: "SteamGridDB" },
];

const ACTION_OPTIONS = [
    { data: "include", label: "Inclusion" },
    { data: "exclude", label: "Exclusion" },
];

const CONDITION_OPTIONS = [
    { data: "collection", label: "Collection" },
    { data: "game_name", label: "Game Title" },
    { data: "regex", label: "Regex Pattern" },
];

const REGEX_EXAMPLES = [
    { pattern: "^Mario.*", desc: "Starts with Mario" },
    { pattern: ".*(Remake|Remaster).*", desc: "Remakes & Remasters" },
    { pattern: ".*(Demo|Beta|Trial).*", desc: "Demos & Betas" },
    { pattern: ".*(Disc|CD)\\s*\\d+.*", desc: "Multi-disc games" },
    { pattern: ".*\\[.*\\].*", desc: "Bracket tags [USA, En...]" },
    { pattern: "CUSA\\d{5}", desc: "PS4 Title IDs (shadPS4)" },
];

export function RulesSection() {
    const ctx = usePanelContext();
    const [rules, setRules] = useSetting("routingRules");
    const [autoMode, setAutoMode] = useSetting("autoRoutingMode");
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);

    // Rule builder state
    const [name, setName] = useState("");
    const [selectedServices, setSelectedServices] = useState<string[]>(["all"]);
    const [action, setAction] = useState<RuleAction>("include");
    const [conditionType, setConditionType] =
        useState<ConditionType>("collection");
    const [pattern, setPattern] = useState("");
    const [suggestionFilter, setSuggestionFilter] = useState("");

    // Collections & Shortcuts for suggestions
    const collections = ctx.routing.listCollections();
    const shortcuts = ctx.routing.listShortcuts();
    const seenShortcutNames = new Set<string>();
    const uniqueShortcuts = shortcuts.filter((s) => {
        if (!s.name || seenShortcutNames.has(s.name)) return false;
        seenShortcutNames.add(s.name);
        return true;
    });

    const filteredCollections = collections.filter((c) =>
        c.name.toLowerCase().includes(suggestionFilter.toLowerCase()),
    );
    const filteredShortcuts = uniqueShortcuts.filter((s) =>
        s.name.toLowerCase().includes(suggestionFilter.toLowerCase()),
    );

    const selectedParts = new Set(
        pattern
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

    const toggleSuggestion = (itemName: string) => {
        const parts = pattern
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (parts.includes(itemName)) {
            setPattern(parts.filter((p) => p !== itemName).join(", "));
        } else {
            setPattern([...parts, itemName].join(", "));
        }
    };

    const toggleService = (svcKey: string) => {
        if (svcKey === "all") {
            setSelectedServices(["all"]);
            return;
        }
        let next = selectedServices.filter((s) => s !== "all");
        if (next.includes(svcKey)) {
            next = next.filter((s) => s !== svcKey);
        } else {
            next.push(svcKey);
        }
        if (next.length === 0 || next.length === SERVICE_OPTIONS.length - 1) {
            setSelectedServices(["all"]);
        } else {
            setSelectedServices(next);
        }
    };

    const handleOpenAdd = () => {
        setEditingIndex(null);
        setName("");
        setSelectedServices(["all"]);
        setAction("include");
        setConditionType("collection");
        setPattern("");
        setSuggestionFilter("");
        setShowAddModal(true);
    };

    const handleOpenEdit = (idx: number) => {
        const r = rules[idx];
        if (!r) return;
        setEditingIndex(idx);
        setName(r.name || "");
        if (!r.service || r.service === "all") {
            setSelectedServices(["all"]);
        } else {
            const split = r.service
                .split(",")
                .map((s) =>
                    s.trim() === "rpcs3" ? "console_emulators" : s.trim(),
                )
                .filter(Boolean);
            setSelectedServices(split.length > 0 ? split : ["all"]);
        }
        setAction(r.action);
        setConditionType(r.conditionType);
        setPattern(r.pattern);
        setSuggestionFilter("");
        setShowAddModal(true);
    };

    const handleSaveRule = async () => {
        if (!name.trim() || !pattern.trim()) return;
        const chosenService = selectedServices.includes("all")
            ? "all"
            : selectedServices.join(",");
        const ruleData: RoutingRule = {
            id:
                editingIndex !== null && rules[editingIndex]
                    ? rules[editingIndex].id
                    : "rule_" + Date.now(),
            name: name.trim(),
            service: chosenService as ServiceTarget,
            action,
            conditionType,
            pattern: pattern.trim(),
            enabled: true,
        };

        const copy = [...rules];
        if (editingIndex !== null) {
            copy[editingIndex] = ruleData;
        } else {
            copy.push(ruleData);
        }
        setRules(copy);
        setShowAddModal(false);
        ctx.ingest.trigger(100);
    };

    const handleDelete = (index: number) => {
        const copy = [...rules];
        copy.splice(index, 1);
        setRules(copy);
        ctx.ingest.trigger(100);
    };

    const isServiceSelected = (key: string) =>
        key === "all" ? selectedServices.includes("all") : !selectedServices.includes("all") && selectedServices.includes(key);

    return (
        <PanelSection title="Routing Rules">
            <Blocks>
                <ToggleRow
                    label="Auto Mode"
                    description="Auto fetches metadata and achievements of the enabled services"
                    value={autoMode}
                    onChange={(val) => {
                        setAutoMode(val);
                        if (val) {
                            ctx.ingest.trigger(100);
                        }
                    }}
                />
                {rules.length > 0 && (
                    <>
                        {/* One row per rule: its name, then the edit and delete buttons. */}
                        {rules.map((rule, idx) => (
                            <ItemRow key={rule.id}>
                                <Field label={rule.name}>
                                    <div style={{ display: "flex", alignItems: "center", gap: CONTROL_GAP }}>
                                        <IconButton onClick={() => handleOpenEdit(idx)} title="Edit">
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
                {/* Three rows: label, description, then the button across the full row. */}
                <FullWidthRows label="Custom Rules" description="Include or exclude games from a service by name, collection or pattern">
                    <DialogButton onClick={handleOpenAdd} style={{ ...BUTTON_STYLE, width: "100%" }}>
                        Add Rule
                    </DialogButton>
                </FullWidthRows>
            </Blocks>

            {/* Add / Edit Rule popup: the same rows and spacing as the panel. */}
            <SettingsModal
                title={editingIndex !== null ? "Edit Rule" : "Add Rule"}
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
            >
                <PanelSection>
                    <Blocks>
                        <ItemRow trailing>
                            <TextField label="Rule Name" value={name} onChange={(e) => setName(e.target.value)} />
                        </ItemRow>
                        <>
                            <ItemRow>
                                <Field label="Services" description="The services this rule applies to" bottomSeparator="none" />
                            </ItemRow>
                            {SERVICE_OPTIONS.map((opt) => (
                                <ToggleRow
                                    key={opt.data}
                                    label={opt.label}
                                    value={isServiceSelected(opt.data)}
                                    onChange={() => toggleService(opt.data)}
                                />
                            ))}
                        </>
                        <FullWidthRows
                            label="Action"
                            description={action === "include" ? "Only apply to matches" : "Never apply to matches"}
                        >
                            <Dropdown
                                rgOptions={ACTION_OPTIONS}
                                selectedOption={action}
                                onChange={(o) => setAction(o.data as RuleAction)}
                                contextMenuPositionOptions={{ bMatchWidth: true }}
                            />
                        </FullWidthRows>
                        <FullWidthRows label="Condition" description="What the pattern is matched against">
                            <Dropdown
                                rgOptions={CONDITION_OPTIONS}
                                selectedOption={conditionType}
                                onChange={(o) => setConditionType(o.data as ConditionType)}
                                contextMenuPositionOptions={{ bMatchWidth: true }}
                            />
                        </FullWidthRows>
                        <>
                            <FullWidthRows
                                label="Pattern"
                                description={
                                    conditionType === "regex"
                                        ? "A regular expression matched against game titles"
                                        : "Separate several items with commas"
                                }
                            >
                                <textarea
                                    rows={Math.min(6, Math.max(2, Math.ceil((pattern.length || 1) / 36)))}
                                    value={pattern}
                                    onChange={(e) => setPattern(e.target.value)}
                                    placeholder={conditionType === "regex" ? "^Mario.*" : "e.g. Mario, Sonic, Zelda"}
                                    style={TEXTAREA_STYLE}
                                />
                            </FullWidthRows>
                            {conditionType === "regex" ? (
                                <ItemRow>
                                    <Field label="Examples" description="Pick one to use it" childrenLayout="below" childrenContainerWidth="max">
                                        <div style={CHIPS_STYLE}>
                                            {REGEX_EXAMPLES.map((ex) => (
                                                <Chip key={ex.pattern} selected={pattern === ex.pattern} onClick={() => setPattern(ex.pattern)}>
                                                    <code>{ex.pattern}</code>
                                                    <span style={{ opacity: 0.6, marginLeft: "6px" }}>{ex.desc}</span>
                                                </Chip>
                                            ))}
                                        </div>
                                    </Field>
                                </ItemRow>
                            ) : (
                                <>
                                    <ItemRow trailing>
                                        <TextField
                                            label={conditionType === "collection" ? "Filter Collections" : "Filter Games"}
                                            value={suggestionFilter}
                                            onChange={(e) => setSuggestionFilter(e.target.value)}
                                        />
                                    </ItemRow>
                                    <ItemRow>
                                        <Field childrenContainerWidth="max">
                                            <div style={CHIPS_STYLE}>
                                                {conditionType === "collection"
                                                    ? filteredCollections.map((c) => (
                                                          <Chip key={c.id} selected={selectedParts.has(c.name)} onClick={() => toggleSuggestion(c.name)}>
                                                              {c.name}
                                                          </Chip>
                                                      ))
                                                    : filteredShortcuts.map((sc) => (
                                                          <Chip key={sc.appid} selected={selectedParts.has(sc.name)} onClick={() => toggleSuggestion(sc.name)}>
                                                              {sc.name}
                                                          </Chip>
                                                      ))}
                                                {(conditionType === "collection" ? filteredCollections : filteredShortcuts).length === 0 && (
                                                    <span style={{ opacity: 0.6 }}>
                                                        {conditionType === "collection" ? "No matching collections" : "No matching games"}
                                                    </span>
                                                )}
                                            </div>
                                        </Field>
                                    </ItemRow>
                                </>
                            )}
                        </>
                        <ActionRow>
                            <DialogButton onClick={handleSaveRule} disabled={!name.trim() || !pattern.trim()} style={BUTTON_STYLE}>
                                Save
                            </DialogButton>
                            <DialogButton onClick={() => setShowAddModal(false)} style={BUTTON_STYLE}>
                                Cancel
                            </DialogButton>
                        </ActionRow>
                    </Blocks>
                </PanelSection>
            </SettingsModal>
        </PanelSection>
    );
}

/** The pattern textarea (Steam has no multi-line text component): dressed like Steam's text field. */
const TEXTAREA_STYLE: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    background: "rgba(0, 0, 0, 0.4)",
    border: "1px solid rgba(255, 255, 255, 0.15)",
    borderRadius: "3px",
    color: "#fff",
    padding: "6px 8px",
    fontSize: "13px",
    fontFamily: "inherit",
    resize: "vertical",
};

/** The pick list of collections, games or examples: values to add to the pattern, wrapped and scrolled. */
const CHIPS_STYLE: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: CONTROL_GAP,
    maxHeight: "130px",
    overflowY: "auto",
    width: "100%",
};

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                background: selected ? "rgba(102, 192, 244, 0.3)" : "rgba(255, 255, 255, 0.08)",
                border: selected ? "1px solid #66c0f4" : "1px solid rgba(255, 255, 255, 0.1)",
                color: selected ? "#66c0f4" : "#fff",
                borderRadius: "3px",
                padding: "3px 8px",
                fontSize: "12px",
                cursor: "pointer",
                textAlign: "left",
            }}
        >
            {children}
        </button>
    );
}
