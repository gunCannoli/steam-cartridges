// Library Setup: the explanation above each step. Each entry is a bold label over its description, close together, in one
// card (guardrail 18: Steam's text, `Card`, `BLOCK_GAP` between cards); the numbers of the Rules step are `StatRow`s and the
// size of the scan is a coloured card on top of the step.
import { Card, CONTROL_GAP, StatRow } from "../components";
import { scanLevel, type ScanLevel } from "../../domain/onboarding";

/** The counts the Rules step shows (null while the library is being read). */
export interface RulesCounts {
    detected: number;
    /** Games the rules put in scope: the ones that will be scanned. */
    inScope: number;
}

const LABEL: React.CSSProperties = { fontWeight: 700, fontSize: 14 };
const TEXT: React.CSSProperties = { fontSize: 13, lineHeight: 1.45, opacity: 0.85 };
const BODY: React.CSSProperties = { padding: 16, display: "flex", flexDirection: "column", gap: CONTROL_GAP + 2 };

function Item({ label, children }: { label: string; children: string }) {
    return (
        <div>
            <div style={LABEL}>{label}</div>
            <div style={TEXT}>{children}</div>
        </div>
    );
}

const LEVEL_COLOR: Record<ScanLevel, string> = { green: "#5ba32b", yellow: "#e5a00d", red: "#e5484d" };

/** The size of the scan, as a card coloured by how long it will take: up to 150 games green, up to 250 yellow, more red. */
export function ScanWarning({ games }: { games: number }) {
    const level = scanLevel(games);
    const color = LEVEL_COLOR[level];
    return (
        <Card style={{ borderColor: color, borderLeft: `4px solid ${color}` }}>
            <div style={BODY}>
                <div style={{ ...LABEL, color }}>
                    {games} game{games === 1 ? "" : "s"} will be scanned. Is that what you want?
                </div>
                {level !== "green" && <div style={TEXT}>Scanning this many games might take a while.</div>}
            </div>
        </Card>
    );
}

export function StepIntro({ step, counts }: { step: number; counts: RulesCounts | null }) {
    return (
        <>
            <Card>
                <div style={BODY}>
                    {step === 0 && (
                        <>
                            <Item label="Welcome to Steam Cartridges">
                                This onboarding will help you get this running, and you only need to follow it once. Pick where Game Info, artwork and media
                                come from; turn on at least one.
                            </Item>
                            <Item label="Steam Store Mirror">Steam's own info for a non-Steam game that has a Steam counterpart. No key needed.</Item>
                            <Item label="SteamGridDB">Artwork and icons, fetched automatically. Needs a free key.</Item>
                            <Item label="ScreenScraper">Game Info, screenshots and manuals; great for retro games. Needs an account.</Item>
                            <Item label="IGDB">Game Info, trailers and artwork; great for retro games. Needs a Twitch Client ID and Secret.</Item>
                            <div style={TEXT}>You can change this any time in Settings › Metadata.</div>
                        </>
                    )}
                    {step === 1 && (
                        <>
                            <Item label="RetroAchievements and the ROM's hash">
                                RetroAchievements identifies a game by the hash of its ROM or disc, so the shortcut has to launch a file RetroAchievements knows. A
                                renamed or patched ROM, or a launcher that hides the file, does not match. A game with no match shows "Missing achievements" in the
                                last step, where you can link it by hand.
                            </Item>
                            <Item label="Console emulators">
                                Unlocks are read from the emulator's own files: RetroArch, DuckStation, PCSX2, Dolphin and PPSSPP (logs), RPCS3 and shadPS4
                                (PlayStation 3 and 4 trophies). Add "Emulators" below to turn this on.
                            </Item>
                            <Item label="Native PC ports">Bloodborne PC and Dusklight write their own trophy files. Add "Native ports" below to turn this on; nothing else to set up.</Item>
                        </>
                    )}
                    {step === 2 && (
                        <>
                            <Item label="Add at least one rule">The plugin scans nothing until you write a rule: you decide which games it may touch.</Item>
                            <Item label="Simple rules">
                                "Scan only these" or "Exclude these", by collection name or by game. Example: scan only the collection "Retro", or exclude "Demos".
                            </Item>
                            <Item label="Advanced rule">
                                For a specific case: one service, a game title or a regex pattern. Example: RetroAchievements only for the collection "Super Nintendo".
                            </Item>
                        </>
                    )}
                </div>
            </Card>
            {step === 2 && counts && (
                <Card>
                    <StatRow label="Non-Steam games detected" value={counts.detected} />
                    <StatRow label="Games that will be ignored" value={counts.detected - counts.inScope} />
                    <StatRow label="Games that will be scanned" value={counts.inScope} />
                </Card>
            )}
        </>
    );
}
