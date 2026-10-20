// Game Data editor: the game's achievements (ADR-0076): where they come from, a RetroAchievements link by URL or id,
// "No achievements" (stop looking) and "Look again". Moved here from the removed Review popup.
import { useState } from "react";
import { Field } from "@steambrew/client";
import { backend } from "../../ports/backend";
import { ActionRow, ButtonRow, Card, ItemRow, TextRows } from "../components";
import type { AchievementState } from "./library-issues";
import { tint, type RunAction } from "./styles";
import { Missing } from "./missing";

const SOURCE_NAMES: Record<string, string> = {
    retroachievements: "RetroAchievements",
    steam: "Steam",
    native_port: "the port's trophies",
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
