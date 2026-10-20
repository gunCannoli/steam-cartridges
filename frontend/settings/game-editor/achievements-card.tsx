// Game Data editor: the game's achievements (ADR-0076): where they come from, a RetroAchievements link by URL or id,
// "No achievements" (stop looking) and "Look again". Moved here from the removed Review popup.
import { useEffect, useState } from "react";
import { Field } from "@steambrew/client";
import { asList } from "../../kernel/lists";
import { backend, type AchievementPackExplain } from "../../ports/backend";
import { ActionRow, ButtonRow, Card, ItemRow, TextRows } from "../components";
import type { AchievementState } from "./library-issues";
import { tint, type RunAction } from "./styles";
import { Missing } from "./missing";

const SOURCE_NAMES: Record<string, string> = {
    retroachievements: "RetroAchievements",
    steam: "Steam",
    native_port: "the port's trophies",
    pack: "an achievement pack",
    rpcs3: "RPCS3",
    shadps4: "shadPS4",
    epic: "Epic Games",
    xbox: "Xbox",
};

function statusLine(state: AchievementState | undefined, waiting: boolean): string {
    if (state?.source === "none") return "Marked as having no achievements: achievement detection is off for it.";
    if (state?.status === "ok" && state.total > 0) return `${state.total} achievements from ${SOURCE_NAMES[state.source ?? ""] ?? state.source ?? "a source"}.`;
    if (waiting) return "Achievement detection has not run for it yet.";
    return "No achievements found. Link the right game, or mark it as having none.";
}

const FILE_STATES: Record<string, string> = {
    found: "found",
    missing: "not created yet (the game writes it on its first unlock)",
    unreadable: "can't read this file",
};

/** Which achievement pack the game uses, what it reads, and the packs not chosen (ADR-0081): how a pack's author
 *  checks the paths. Nothing for a game no pack matches. */
function PackLines({ appid, ask, marked }: { appid: number; ask: boolean; marked: boolean }) {
    const [info, setInfo] = useState<AchievementPackExplain | null>(null);
    useEffect(() => {
        let live = true;
        setInfo(null);
        if (ask) backend.achievementPacksExplain(appid).then((r) => live && setInfo(r)).catch(() => {});
        return () => {
            live = false;
        };
    }, [appid, ask]);
    if (!info) return null;
    const others = asList<{ id: string; why: string }>(info.others);
    const files = asList<{ path: string; state: string; unlocks: number }>(info.files);
    if (!info.pack && others.length === 0) return null;
    if (marked) {
        const id = info.pack ?? others[0]?.id;
        return (
            <ItemRow>
                <Field
                    label="An achievement pack matches this game"
                    description={`"${id}". Use Retry achievement detection below to let it give the game its achievements.`}
                    bottomSeparator="none"
                />
            </ItemRow>
        );
    }
    return (
        <>
            {info.pack && (
                <ItemRow>
                    <Field label={`Achievement pack: ${info.pack}`} description="Reads the game's achievements from:" bottomSeparator="none" />
                </ItemRow>
            )}
            {files.map((f) => (
                <ItemRow key={f.path}>
                    <Field
                        label={<span style={{ fontWeight: 400, wordBreak: "break-all" }}>{f.path}</span>}
                        description={f.state === "found" ? `found, ${f.unlocks} unlocked` : FILE_STATES[f.state] ?? f.state}
                        bottomSeparator="none"
                    />
                </ItemRow>
            ))}
            {others.map((o) => (
                <ItemRow key={o.id}>
                    <Field label={`Also matches: ${o.id}`} description={`Not used: ${o.why}.`} bottomSeparator="none" />
                </ItemRow>
            ))}
        </>
    );
}

export function AchievementsCard({
    appid,
    state,
    waiting,
    missing,
    busy,
    run,
    status,
}: {
    appid: number;
    state: AchievementState | undefined;
    waiting: boolean;
    missing: boolean;
    busy: boolean;
    run: RunAction;
    status?: string;
}) {
    const [ra, setRa] = useState("");
    const marked = state?.source === "none";
    const found = state?.status === "ok" && state.total > 0;

    return (
        <Card style={tint(missing)}>
            <Missing on={missing}>
                <ItemRow>
                    <Field label="Achievements" description={statusLine(state, waiting)} bottomSeparator="none" />
                </ItemRow>
            </Missing>
            <PackLines
                appid={appid}
                ask={!found || marked || state?.source === "pack" || state?.source === "native_port"}
                marked={marked}
            />
            <TextRows label="RetroAchievements game" description="Its URL (retroachievements.org/game/1234) or id" value={ra} onChange={setRa} />
            <ButtonRow
                label="Link RetroAchievements"
                description="For a ROM the automatic match got wrong"
                buttonLabel="Link"
                disabled={busy || !ra.trim()}
                onClick={() =>
                    run(async () => {
                        const res = await backend.setAchievementSource(appid, "ra", ra.trim());
                        if (!res.ok) return { error: res.error ?? "Could not link RetroAchievements." };
                        setRa("");
                        return {};
                    }, "Linked to RetroAchievements.", "Linking to RetroAchievements...", "achievements")
                }
            />
            {marked ? (
                <ButtonRow
                    label="Retry achievement detection"
                    description="Allow achievement detection for this game to run again"
                    buttonLabel="Retry"
                    disabled={busy}
                    onClick={() =>
                        run(async () => {
                            const res = await backend.clearAchievementSource(appid);
                            if (!res.ok) return { error: res.error ?? "Could not clear." };
                            return {};
                        }, "Achievement detection will run again for this game.", "Retrying achievement detection...", "achievements")
                    }
                />
            ) : found ? null : (
                <ButtonRow
                    label="No achievements"
                    description="This game has none: turn achievement detection off for it"
                    buttonLabel="No achievements"
                    disabled={busy}
                    onClick={() =>
                        run(async () => {
                            const res = await backend.setAchievementSource(appid, "none");
                            if (!res.ok) return { error: res.error ?? "Could not mark it." };
                            return {};
                        }, "Marked as having no achievements.", "Marking...", "achievements")
                    }
                />
            )}
            {status && <ActionRow message={status} />}
        </Card>
    );
}
