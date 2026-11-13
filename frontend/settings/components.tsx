// Shared building blocks of the settings panels (migration plan M8c). The spacing system and row kinds are the ones of
// enhanced-notifications (its settings/rows.tsx), the reference; the rules are in docs/plugins.md § Settings panel layout.
import { Children, useEffect, useState } from "react";
import { DialogButton, Field, PanelSectionRow, SliderField, Spinner, TextField, Toggle as SteamToggle } from "@steambrew/client";

/** Steam's settings-card background (a Field's own), measured live: rgb(35, 38, 46). */
export const CARD_BACKGROUND = "rgb(35, 38, 46)";

/**
 * Spacing system. A *block* is a group of options that read as one card: its rows touch (no gap). Blocks in a section
 * are `BLOCK_GAP` apart, set in one place (`Blocks`). Steam's TextField ends with `STEAM_TRAILING` of blank space of
 * its own; `ItemRow` cancels it (`trailing`) so a block's spacing never depends on its last control. SliderRow keeps
 * Steam's slider margin (see there).
 */
export const BLOCK_GAP = 22;
export const STEAM_TRAILING = 22;
/** Between stacked controls inside one custom card. */
export const CONTROL_GAP = 8;

const ITEM_ROW_STYLE: React.CSSProperties = {
    margin: "0",
    padding: "0",
};

export function ItemRow({ children, trailing }: { children: React.ReactNode; trailing?: boolean }) {
    return (
        <PanelSectionRow>
            <div style={trailing ? { ...ITEM_ROW_STYLE, marginBottom: -STEAM_TRAILING } : ITEM_ROW_STYLE}>{children}</div>
        </PanelSectionRow>
    );
}

/** Whatever a theme does to the panel's container (Millennium's custom CSS can make it a grid of narrow columns, a
 *  flex row, or a different width), the section is one full-width column: one child for the container to place,
 *  spanning every grid column, allowed to shrink. */
export const COLUMN_STYLE: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    gridColumn: "1 / -1",
    flex: "1 1 100%",
};

/** The blocks of one section, `BLOCK_GAP` apart. Pass each block as one child (a fragment of rows). Padding, not margin: margins would collapse into Steam's own trailing margin. */
export function Blocks({ children }: { children: React.ReactNode }) {
    return (
        <div style={COLUMN_STYLE}>
            {Children.toArray(children).map((block, i) => (
                <div key={i} style={{ paddingTop: i === 0 ? 0 : BLOCK_GAP, minWidth: 0 }}>
                    {block}
                </div>
            ))}
        </div>
    );
}

export function ToggleRow({
    label,
    description,
    value,
    onChange,
    disabled,
}: {
    label: string;
    description?: string;
    value: boolean;
    onChange: (val: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <ItemRow>
            <Field label={label} description={description} disabled={disabled}>
                <SteamToggle value={value} disabled={disabled} onChange={onChange} />
            </Field>
        </ItemRow>
    );
}

/** Steam's slider across the full row, the value shown with its suffix: enhanced-notifications' SliderRow, so both
 *  plugins draw sliders the same way (a toggle row, then its slider, in one block). The slider keeps its own 22 px
 *  bottom margin: as a section's last row that margin is the gap to the next section (measured live: cancelling it
 *  left 2 px). Followed by another block in the same section, it would double the block gap. */
export function SliderRow({
    label,
    value,
    min,
    max,
    step,
    suffix,
    resetValue,
    onChange,
    disabled,
    trailing,
}: {
    /** Left out when a Field row above already names the slider. */
    label?: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix: string;
    resetValue: number;
    onChange: (val: number) => void;
    disabled?: boolean;
    trailing?: boolean;
}) {
    return (
        <ItemRow trailing={trailing ?? true}>
            <SliderField
                label={label}
                layout="below"
                value={value}
                min={min}
                max={max}
                step={step}
                showValue
                valueSuffix={suffix}
                resetValue={resetValue}
                disabled={disabled}
                onChange={onChange}
            />
        </ItemRow>
    );
}

/** A number on the right of a row (the Library Analytics counts). `warn` colours it when it asks for attention. */
export function StatRow({
    label,
    value,
    warn,
    onClick,
}: {
    label: string;
    value: number;
    warn?: boolean;
    onClick?: () => void;
}) {
    const [hover, setHover] = useState(false);
    return (
        <ItemRow>
            <Field label={label}>
                <span
                    onClick={onClick}
                    onMouseEnter={() => setHover(true)}
                    onMouseLeave={() => setHover(false)}
                    title={onClick ? "Click to view games" : undefined}
                    style={{
                        fontWeight: 700,
                        color: warn && value > 0 ? "#e5a00d" : hover && onClick ? "#ffffff" : undefined,
                        cursor: onClick ? "pointer" : undefined,
                        background: onClick && hover ? "rgba(255, 255, 255, 0.15)" : onClick ? "rgba(255, 255, 255, 0.07)" : undefined,
                        padding: onClick ? "3px 10px" : undefined,
                        borderRadius: onClick ? "4px" : undefined,
                        border: onClick ? "1px solid rgba(255, 255, 255, 0.12)" : undefined,
                        boxShadow: onClick && hover ? "0 0 6px rgba(255, 255, 255, 0.2)" : undefined,
                        transition: "all 0.15s ease",
                        userSelect: "none",
                        display: "inline-block",
                    }}
                >
                    {value}
                </span>
            </Field>
        </ItemRow>
    );
}

/** A row's small icon button (remove, edit, info). One fixed size, so different glyphs line up. */
export function IconButton({ onClick, title, children, style }: { onClick: () => void; title?: string; children: React.ReactNode; style?: React.CSSProperties }) {
    return (
        <DialogButton
            onClick={onClick}
            title={title}
            style={{ padding: 0, minWidth: 0, width: "40px", fontSize: "14px", lineHeight: "normal", ...style }}
        >
            {children}
        </DialogButton>
    );
}

/** A button sized to its label (popup actions, ButtonRow). */
export const BUTTON_STYLE: React.CSSProperties = { padding: "0 16px", minWidth: 0, width: "auto" };

/** Steam's own small spinner (a missing export draws nothing rather than breaking the panel). */
export function LoadingSpinner() {
    if (typeof Spinner !== "function" && typeof Spinner !== "object") return null;
    return <Spinner style={{ width: 18, height: 18, flexShrink: 0 }} />;
}

/** The last row of a popup: a status message on the left, its buttons on the right. A message ending in "..." is
 *  progress (with Steam's spinner beside it: the work runs in the background), one starting with "✓" success (green),
 *  one starting with "⚠" a warning (yellow: it worked, with a catch), anything else an error (red). */
export function ActionRow({ message, progress: explicit, children }: { message?: string; progress?: boolean; children?: React.ReactNode }) {
    // `progress` set by the caller wins (a status with an ETA does not end in "..."); a ✓ / ⚠ result is never progress.
    const done = !!message && (message.startsWith("✓") || message.startsWith("⚠"));
    const progress = !!message && !done && (explicit ?? message.endsWith("..."));
    const color = !message ? undefined : message.startsWith("✓") ? "#a4d007" : message.startsWith("⚠") ? "#e5a00d" : progress ? undefined : "#eb4b4b";
    const label = message ? (
        <span style={{ color, fontWeight: 400, display: "inline-flex", alignItems: "center", gap: CONTROL_GAP }}>
            {progress && <LoadingSpinner />}
            {message}
        </span>
    ) : undefined;
    return (
        <ItemRow>
            <Field label={label} bottomSeparator="none">
                {children && <div style={{ display: "flex", gap: CONTROL_GAP }}>{children}</div>}
            </Field>
        </ItemRow>
    );
}

/** The privacy note of a popup that asks for an account or a key. */
export function CredentialsNote({ service }: { service: string }) {
    return (
        <ItemRow>
            <Field
                label="Protected on this PC"
                description={`Saved on this PC, protected. Sent only to ${service}, never logged or shared.`}
                bottomSeparator="none"
            />
        </ItemRow>
    );
}

/** One row: label and description on the left, one button on the right (two columns, the most a row may have). */
export function ButtonRow({
    label,
    description,
    buttonLabel,
    disabled,
    onClick,
}: {
    label: string;
    description?: string;
    buttonLabel: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <ItemRow>
            <Field label={label} description={description} disabled={disabled}>
                <DialogButton disabled={disabled} onClick={onClick} style={BUTTON_STYLE}>
                    {buttonLabel}
                </DialogButton>
            </Field>
        </ItemRow>
    );
}

/** A control that needs room (a dropdown, a button): three rows, label, description, then the control across the full row. */
export function FullWidthRows({
    label,
    description,
    disabled,
    children,
}: {
    label: string;
    description?: string;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <>
            <ItemRow>
                <Field label={label} description={description} disabled={disabled} bottomSeparator="none" />
            </ItemRow>
            <ItemRow>
                <Field disabled={disabled} childrenContainerWidth="max">
                    {children}
                </Field>
            </ItemRow>
        </>
    );
}

/** The frame of a popup window (guardrail 18.8): the window's background and padding, a scrolling column of cards `BLOCK_GAP` apart,
 *  and a last card with the window's buttons (an `ActionRow`). */
export function WindowFrame({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                gap: BLOCK_GAP,
                height: "100vh",
                minHeight: 360,
                padding: BLOCK_GAP,
                boxSizing: "border-box",
                background: "#1b2838",
                color: "#dcdedf",
            }}
        >
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
                <div style={{ ...COLUMN_STYLE, maxWidth: 900, margin: "0 auto", gap: BLOCK_GAP }}>{children}</div>
            </div>
            <Card>{footer}</Card>
        </div>
    );
}

/** One block drawn as a card (Steam's settings-card colour), for a popup whose blocks sit on a darker background. */
export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
    return (
        <div style={{ background: CARD_BACKGROUND, borderRadius: "4px", border: "1px solid rgba(255, 255, 255, 0.08)", overflow: "hidden", ...style }}>
            {children}
        </div>
    );
}

/** A layer over `children` while `on` (a highlight): Steam's rows paint their own background, so a tint under them
 *  never shows; this one lies on top and lets every click through. */
export function Overlay({ on, color, edge, children }: { on: boolean; color: string; edge?: string; children: React.ReactNode }) {
    if (!on) return <>{children}</>;
    return (
        <div style={{ position: "relative" }}>
            {children}
            <div style={{ position: "absolute", inset: 0, background: color, boxShadow: edge ? `inset 3px 0 0 ${edge}` : undefined, pointerEvents: "none" }} />
        </div>
    );
}

/** The eye of the password field: open while the password is shown, crossed out while it is hidden. */
function EyeIcon({ open }: { open: boolean }) {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
            {!open && <path d="M3 3l18 18" />}
        </svg>
    );
}

/** A text field (guardrail 18.3): its label and description in Steam's own indent, then the field across the full row. */
export function TextRows({
    label,
    description,
    value,
    onChange,
    onKeyDown,
    onCommit,
    password,
    disabled,
}: {
    label: string;
    description?: string;
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    /** Called when the field loses focus or Enter is pressed (auto-save). */
    onCommit?: () => void;
    password?: boolean;
    disabled?: boolean;
}) {
    // A password is hidden as it is typed (each character shows as a dot) until the eye at the right of the field is clicked.
    const [shown, setShown] = useState(false);
    const hidden = password === true && !shown;
    // One Field with the control below its label, like a textarea; Steam puts the description under the control. The
    // TextField's own 22 px tail is cancelled inside the Field, so the description follows the field closely and the
    // row ends with Steam's own spacing (measured live 2026-10-19).
    return (
        <ItemRow>
            <Field label={label} description={description} disabled={disabled} childrenLayout="below" childrenContainerWidth="max" bottomSeparator="none">
                <div
                    className={`cartridges-input-track${password ? " has-trailing" : ""}`}
                    style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "stretch",
                        gap: 0,
                        minHeight: "38px",
                    }}
                >
                    <style>{`
                        .cartridges-input-track .DialogInput_Wrapper {
                            width: 100% !important;
                            max-width: 100% !important;
                            flex: 1 1 auto !important;
                            min-width: 0 !important;
                            display: flex !important;
                            align-items: stretch !important;
                        }
                        .cartridges-input-track .DialogInput_Wrapper > input.DialogInput {
                            width: 100% !important;
                            max-width: 100% !important;
                            min-height: 38px !important;
                            height: auto !important;
                            box-sizing: border-box !important;
                            padding: 8px 12px !important;
                            line-height: normal !important;
                        }
                        .cartridges-input-track.has-trailing .DialogInput_Wrapper > input.DialogInput {
                            border-top-right-radius: 0 !important;
                            border-bottom-right-radius: 0 !important;
                        }
                    `}</style>
                    {/* `-webkit-text-security` masks the text whatever the TextField does with `bIsPassword` (it showed the typed text in a popup window). */}
                    <div
                        style={{
                            flex: "1 1 auto",
                            minWidth: 0,
                            display: "flex",
                            width: "100%",
                            ...(hidden ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : {}),
                        }}
                    >
                        <TextField
                            value={value}
                            bIsPassword={hidden}
                            disabled={disabled}
                            onChange={(e) => onChange(e.target.value)}
                            onKeyDown={(e: React.KeyboardEvent) => {
                                onKeyDown?.(e);
                                if (onCommit && e.key === "Enter") onCommit();
                            }}
                            onBlur={onCommit}
                            style={{
                                width: "100%",
                                maxWidth: "100%",
                                minHeight: "38px",
                                height: "auto",
                                padding: "8px 12px",
                                lineHeight: "normal",
                                boxSizing: "border-box",
                                borderTopRightRadius: password ? 0 : "3px",
                                borderBottomRightRadius: password ? 0 : "3px",
                            }}
                        />
                    </div>
                    {password && (
                        <DialogButton
                            onClick={() => setShown(!shown)}
                            title={shown ? "Hide" : "Show"}
                            style={{
                                flex: "0 0 auto",
                                margin: 0,
                                padding: 0,
                                minWidth: "40px",
                                width: "40px",
                                minHeight: "38px",
                                height: "auto",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                boxSizing: "border-box",
                                borderTopLeftRadius: 0,
                                borderBottomLeftRadius: 0,
                                borderTopRightRadius: "3px",
                                borderBottomRightRadius: "3px",
                                borderLeft: "1px solid rgba(255, 255, 255, 0.08)",
                                fontSize: "14px",
                                lineHeight: "normal",
                            }}
                        >
                            <EyeIcon open={shown} />
                        </DialogButton>
                    )}
                </div>
            </Field>
        </ItemRow>
    );
}

/**
 * Clean native select styled like Steam's DialogDropDown.
 * Completely immune to modal portal, z-index, or context menu event interception issues.
 */
export function Select({
    options,
    value,
    onChange,
    disabled,
    style,
}: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (val: string) => void;
    disabled?: boolean;
    style?: React.CSSProperties;
}) {
    return (
        <select
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            style={{
                width: "100%",
                backgroundColor: "rgba(59, 63, 72, 0.5)",
                color: "#dfe3e6",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                borderRadius: "3px",
                padding: "8px 12px",
                fontSize: "14px",
                height: "38px",
                outline: "none",
                cursor: disabled ? "not-allowed" : "pointer",
                boxSizing: "border-box",
                ...style,
            }}
        >
            {options.map((opt) => (
                <option key={opt.value} value={opt.value} style={{ background: "#1b2838", color: "#dfe3e6" }}>
                    {opt.label}
                </option>
            ))}
        </select>
    );
}

/**
 * Clean Steam-themed modal dialog for popups.
 */
interface SettingsModalProps {
    title: string;
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
    width?: string;
    maxHeight?: string;
}

export function SettingsModal({
    title,
    isOpen,
    onClose,
    children,
    width = "520px",
    maxHeight = "85vh",
}: SettingsModalProps) {
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div
            style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(0, 0, 0, 0.75)",
                backdropFilter: "blur(3px)",
                zIndex: 10000,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "20px",
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: "#1b2838",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    borderRadius: "6px",
                    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.85)",
                    width,
                    maxWidth: "94vw",
                    maxHeight,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div
                    style={{
                        padding: "12px 18px",
                        borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: "rgba(0, 0, 0, 0.25)",
                    }}
                >
                    <span
                        style={{
                            fontSize: "14px",
                            fontWeight: 700,
                            color: "#fff",
                        }}
                    >
                        {title}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            background: "transparent",
                            border: "none",
                            color: "#8b929a",
                            fontSize: "18px",
                            cursor: "pointer",
                            padding: "0 4px",
                            lineHeight: 1,
                        }}
                    >
                        ✕
                    </button>
                </div>

                {/* Body */}
                <div
                    style={{
                        padding: "16px 18px",
                        overflowY: "auto",
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        gap: "12px",
                    }}
                >
                    {children}
                </div>
            </div>
        </div>
    );
}

const MDI_CLIPBOARD =
    "M20 3H16.8C16.4 1.8 15.3 1 14 1C12.7 1 11.6 1.8 11.2 3H8C6.9 3 6 3.9 6 5V17C6 18.1 6.9 19 8 19H20C21.1 19 22 18.1 22 17V5C22 3.9 21.1 3 20 3M14 3C14.6 3 15 3.5 15 4C15 4.5 14.5 5 14 5C13.5 5 13 4.5 13 4C13 3.5 13.4 3 14 3M16 14H9V12H16M19 10H9V8H19M4 21H18V23H4C2.9 23 2 22.1 2 21V7H4";
const MDI_CLIPBOARD_CHECK =
    "M4 7H2V21C2 22.1 2.9 23 4 23H18V21H4M20 3H16.8C16.4 1.8 15.3 1 14 1C12.7 1 11.6 1.8 11.2 3H8C6.9 3 6 3.9 6 5V17C6 18.1 6.9 19 8 19H20C21.1 19 22 18.1 22 17V5C22 3.9 21.1 3 20 3M14 3C14.6 3 15 3.5 15 4C15 4.5 14.5 5 14 5C13.5 5 13 4.5 13 4C13 3.5 13.4 3 14 3M12.3 15.1L9 11.8L10.4 10.4L12.3 12.3L17.6 7L19 8.4";

/** Copies to the clipboard: the async API when the window allows it, else a hidden textarea. */
async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;left:-10000px;top:0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
    }
}

/** A code that copies itself when clicked: a clipboard icon that lights up on hover, becomes a check once copied, and is a clipboard again when the pointer leaves. */
export function CopyCode({ text }: { text: string }) {
    const [hover, setHover] = useState(false);
    const [copied, setCopied] = useState(false);
    return (
        <span
            role="button"
            title={copied ? "Copied" : "Copy the code"}
            onClick={async () => setCopied(await copyText(text))}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => {
                setHover(false);
                setCopied(false);
            }}
            style={{ display: "inline-flex", alignItems: "center", gap: "10px", cursor: "pointer", userSelect: "none" }}
        >
            <span style={{ fontFamily: "monospace", letterSpacing: "2px" }}>{text}</span>
            <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                style={{ fill: copied ? "#59bf40" : hover ? "#ffffff" : "currentColor", opacity: hover || copied ? 1 : 0.55, transition: "opacity 0.15s, fill 0.15s" }}
            >
                <path d={copied ? MDI_CLIPBOARD_CHECK : MDI_CLIPBOARD} />
            </svg>
        </span>
    );
}

/** A web address that opens in the system browser when clicked. */
export function ExternalLink({ url, children }: { url: string; children?: React.ReactNode }) {
    return (
        <a
            href={url}
            onClick={(event) => {
                event.preventDefault();
                (Reflect.get(globalThis, "SteamClient") as { System?: { OpenInSystemBrowser?: (u: string) => void } } | undefined)?.System?.OpenInSystemBrowser?.(url);
            }}
            style={{ color: "#1a9fff", textDecoration: "underline", cursor: "pointer" }}
        >
            {children ?? url}
        </a>
    );
}
