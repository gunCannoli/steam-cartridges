// The rule editor window (ADR-0089): opened by Routing Rules' "Add rule" and the edit button, in its own window as big as the
// Library Setup one. One window for every kind of rule: a simple one ("Scan only these", "Exclude these", by collection or
// game) or an advanced one (services, game title or regex, include / exclude / scan only these).
import { useMemo, useState } from "react";
import { DialogButton, Dropdown, Field } from "@steambrew/client";
import { useSetting } from "../settings";
import { ruleMatches, type ConditionType, type RoutingRule, type RuleAction, type ServiceTarget } from "../../domain/routing/policy";
import { usePanelContext } from "../context";
import { backend } from "../../ports/backend";
import { BUTTON_STYLE, Card, CONTROL_GAP, FullWidthRows, ItemRow, TextRows, ToggleRow, WindowFrame } from "../components";

type RuleKind = "only" | "exclude" | "advanced";

const KIND_OPTIONS = [
    { data: "only", label: "Scan only these" },
    { data: "exclude", label: "Exclude these" },
    { data: "advanced", label: "Advanced" },
];

const SERVICE_OPTIONS = [
    { data: "all", label: "All services" },
    { data: "steam_store", label: "Steam Store Mirror" },
    { data: "retroachievements", label: "RetroAchievements" },
    { data: "console_emulators", label: "Console Emulators" },
    { data: "screenscraper", label: "ScreenScraper" },
    { data: "igdb", label: "IGDB" },
    { data: "steamgriddb", label: "SteamGridDB" },
];

const ACTION_OPTIONS = [
    { data: "only", label: "Scan only these" },
    { data: "exclude", label: "Exclude" },
    { data: "include", label: "Always include" },
];

const REGEX_EXAMPLES = [
    { pattern: "^Mario.*", desc: "Starts with Mario" },
    { pattern: ".*(Remake|Remaster).*", desc: "Remakes & Remasters" },
    { pattern: ".*(Demo|Beta|Trial).*", desc: "Demos & Betas" },
    { pattern: ".*(Disc|CD)\\s*\\d+.*", desc: "Multi-disc games" },
    { pattern: "CUSA\\d{5}", desc: "PS4 Title IDs (shadPS4)" },
];

const KIND_HINT: Record<RuleKind, string> = {
    only: "Only the collections or games you pick are scanned; every other game is left alone.",
    exclude: "The collections or games you pick are never scanned.",
    advanced: "For a specific case: pick the services, the action and how games are matched.",
};

/** A saved rule read back into the editor: simple when it covers every service, by collection or title. */
function kindOf(rule: RoutingRule | undefined): RuleKind {
    if (!rule) return "only";
    const simple = (!rule.service || rule.service === "all") && rule.conditionType !== "regex" && (rule.action === "only" || rule.action === "exclude");
    return simple ? (rule.action as RuleKind) : "advanced";
}

export function RuleEditorWindow({ index, closeModal }: { index?: number; closeModal?: () => void }) {
    const ctx = usePanelContext();
    const [rules, setRules] = useSetting("routingRules");
    const editing = index !== undefined ? rules[index] : undefined;

    const [kind, setKind] = useState<RuleKind>(kindOf(editing));
    const [name, setName] = useState(editing?.name ?? "");
    const [services, setServices] = useState<string[]>(() => {
        if (!editing || !editing.service || editing.service === "all") return kind === "advanced" ? ["retroachievements"] : ["all"];
        return editing.service.split(",").map((s) => (s.trim() === "rpcs3" ? "console_emulators" : s.trim())).filter(Boolean);
    });
    const [action, setAction] = useState<RuleAction>(editing?.action ?? "only");
    const [condition, setCondition] = useState<ConditionType>(editing?.conditionType ?? "collection");
    const [pattern, setPattern] = useState(editing?.pattern ?? "");
    const [filter, setFilter] = useState("");

    const advanced = kind === "advanced";
    const effectiveCondition: ConditionType = !advanced && condition === "regex" ? "collection" : condition;

    // Read once: the lists do not change while the editor is open, and every click or keystroke re-renders it.
    const allCollections = useMemo(() => ctx.routing.listCollections(), []); // eslint-disable-line react-hooks/exhaustive-deps
    const allGames = useMemo(() => {
        const seen = new Set<string>();
        return ctx.routing.listShortcuts().filter((s) => s.name && !seen.has(s.name) && seen.add(s.name));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const collections = allCollections.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
    const games = allGames.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));

    const parts = pattern.split(",").map((s) => s.trim()).filter(Boolean);
    const selected = new Set(parts);
    const toggleItem = (item: string) => setPattern((parts.includes(item) ? parts.filter((p) => p !== item) : [...parts, item]).join(", "));

    const pickKind = (next: RuleKind) => {
        setKind(next);
        if (next === "advanced") {
            setAction(action === "include" || action === "exclude" || action === "only" ? action : "only");
            if (services.includes("all")) setServices(["retroachievements"]);
        } else {
            setServices(["all"]);
            setAction(next);
            if (condition === "regex") setCondition("collection");
        }
    };

    const toggleService = (key: string) => {
        if (key === "all") return setServices(["all"]);
        const next = services.filter((s) => s !== "all");
        const out = next.includes(key) ? next.filter((s) => s !== key) : [...next, key];
        setServices(out.length === 0 || out.length === SERVICE_OPTIONS.length - 1 ? ["all"] : out);
    };

    const canSave = name.trim() !== "" && pattern.trim() !== "";
    const save = () => {
        if (!canSave) return;
        const rule: RoutingRule = {
            id: editing?.id ?? "rule_" + Date.now(),
            name: name.trim(),
            service: (services.includes("all") ? "all" : services.join(",")) as ServiceTarget,
            action: advanced ? action : kind,
            conditionType: effectiveCondition,
            pattern: pattern.trim(),
            enabled: true,
        };
        const copy = [...rules];
        if (index !== undefined && copy[index]) copy[index] = rule;
        else copy.push(rule);
        setRules(copy);
        // Shape and reach only in the log: never the rule's name or pattern (user data).
        backend.logEvent("rules", `${index === undefined ? "added" : "edited"} ${rule.action}/${rule.conditionType} for ${rule.service}, matching ${matchCount} games (${copy.length} rules)`);
        ctx.ingest.trigger(100, "rules");
        closeModal?.();
    };

    const chips = effectiveCondition === "collection"
        ? collections.map((c) => ({ key: c.id, label: c.name }))
        : games.map((s) => ({ key: String(s.appid), label: s.name }));

    // How many non-Steam games the rule catches as it stands (its condition only, whatever the services).
    // The games and the collections each is in are read once; only the matching runs as the pattern is typed.
    const library = useMemo(() => {
        const names = new Map<number, string[]>();
        for (const c of ctx.routing.listCollections()) {
            for (const appid of ctx.routing.membersOf(c.id) ?? []) names.set(appid, [...(names.get(appid) ?? []), c.name]);
        }
        return ctx.routing.listShortcuts().map((s) => ({ name: s.name, collections: names.get(s.appid) ?? [] }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const matchCount = useMemo(
        () => (pattern.trim() === "" ? 0 : library.filter((g) => ruleMatches({ conditionType: effectiveCondition, pattern: pattern.trim() }, g.name, g.collections)).length),
        [library, pattern, effectiveCondition],
    );
    const saveHint = !canSave
        ? "Give the rule a name and pick at least one item."
        : `${matchCount} non-Steam game${matchCount === 1 ? "" : "s"} in this rule`;

    return (
        <WindowFrame
            footer={
                <ItemRow>
                    <Field label={editing ? "Edit rule" : "New rule"} description={pattern.trim() === "" ? saveHint : `${matchCount} non-Steam game${matchCount === 1 ? "" : "s"} in this rule${canSave ? "" : ". Give the rule a name to save it."}`} bottomSeparator="none">
                        <div style={{ display: "flex", gap: CONTROL_GAP }}>
                            <DialogButton disabled={!canSave} onClick={save} style={BUTTON_STYLE}>
                                Save
                            </DialogButton>
                            <DialogButton onClick={() => closeModal?.()} style={BUTTON_STYLE}>
                                Cancel
                            </DialogButton>
                        </div>
                    </Field>
                </ItemRow>
            }
        >
            <Card>
                <FullWidthRows label="Rule type" description={KIND_HINT[kind]}>
                    <Dropdown rgOptions={KIND_OPTIONS} selectedOption={kind} onChange={(o) => pickKind(o.data as RuleKind)} contextMenuPositionOptions={{ bMatchWidth: true }} />
                </FullWidthRows>
                <TextRows label="Rule name" description="Shown in the list of rules." value={name} onChange={setName} />
            </Card>

            {advanced && (
                <Card>
                    <ItemRow>
                        <Field label="Services" description="The services this rule applies to" bottomSeparator="none" />
                    </ItemRow>
                    {SERVICE_OPTIONS.map((opt) => (
                        <ToggleRow
                            key={opt.data}
                            label={opt.label}
                            value={opt.data === "all" ? services.includes("all") : !services.includes("all") && services.includes(opt.data)}
                            onChange={() => toggleService(opt.data)}
                        />
                    ))}
                    <FullWidthRows label="Action">
                        <Dropdown rgOptions={ACTION_OPTIONS} selectedOption={action} onChange={(o) => setAction(o.data as RuleAction)} contextMenuPositionOptions={{ bMatchWidth: true }} />
                    </FullWidthRows>
                </Card>
            )}

            <Card>
                <FullWidthRows label="Match by">
                    <Dropdown
                        rgOptions={[
                            { data: "collection", label: "Collection" },
                            { data: "game_name", label: "Game title" },
                            ...(advanced ? [{ data: "regex", label: "Regex pattern" }] : []),
                        ]}
                        selectedOption={effectiveCondition}
                        onChange={(o) => setCondition(o.data as ConditionType)}
                        contextMenuPositionOptions={{ bMatchWidth: true }}
                    />
                </FullWidthRows>
                <FullWidthRows
                    label={effectiveCondition === "regex" ? "Regex pattern" : effectiveCondition === "collection" ? "Collections in this rule" : "Games in this rule"}
                    description={effectiveCondition === "regex" ? "A regular expression matched against game titles. Pick an example below to start." : "The names the rule applies to. Click items below to add or remove them, or type names separated by commas."}
                >
                    <textarea
                        rows={3}
                        value={pattern}
                        onChange={(e) => setPattern(e.target.value)}
                        placeholder={effectiveCondition === "regex" ? "^Mario.*" : "e.g. Mario, Sonic, Zelda"}
                        style={TEXTAREA_STYLE}
                    />
                </FullWidthRows>
                {effectiveCondition === "regex" ? (
                    <div style={CHIPS_STYLE}>
                        {REGEX_EXAMPLES.map((ex) => (
                            <Chip key={ex.pattern} selected={pattern === ex.pattern} onClick={() => setPattern(ex.pattern)}>
                                <code>{ex.pattern}</code>
                                <span style={{ opacity: 0.6, marginLeft: 6 }}>{ex.desc}</span>
                            </Chip>
                        ))}
                    </div>
                ) : (
                    <>
                        <TextRows label={effectiveCondition === "collection" ? "Filter collections" : "Filter games"} value={filter} onChange={setFilter} />
                        {/* Every item is shown: the list keeps the card's width and grows in rows. */}
                        <div style={CHIPS_STYLE}>
                            {chips.map((c) => (
                                <Chip key={c.key} selected={selected.has(c.label)} onClick={() => toggleItem(c.label)}>
                                    {c.label}
                                </Chip>
                            ))}
                            {chips.length === 0 && <span style={{ opacity: 0.6 }}>{effectiveCondition === "collection" ? "No matching collections" : "No matching games"}</span>}
                        </div>
                    </>
                )}
            </Card>
        </WindowFrame>
    );
}

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

const CHIPS_STYLE: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: CONTROL_GAP,
    padding: CONTROL_GAP * 2,
    boxSizing: "border-box",
    minWidth: 0,
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
