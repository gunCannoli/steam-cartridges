// The Playtime block of a game's Properties > Cartridge page (2026-11-12): the tracked total, editable in hours (saved on
// Enter or when the field loses focus, like the Game Info fields), and when it was last played. Shown only with Track
// Playtime on (General). Reads the app only through usePanelContext().
import { useEffect, useState } from "react";
import { Field } from "@steambrew/client";
import { ActionRow, Card, ItemRow, TextRows } from "../components";
import { usePanelContext } from "../context";
import { formatHours, parseHours } from "../../domain/playtime-format";

export function PlaytimeCard({ appid }: { appid: number }) {
    const ctx = usePanelContext();
    const api = ctx.playtime;
    const [entry, setEntry] = useState(() => api?.of(appid));
    const [text, setText] = useState(() => formatHours(entry?.minutes ?? 0));
    const [status, setStatus] = useState<string | undefined>();

    useEffect(() => {
        const e = api?.of(appid);
        setEntry(e);
        setText(formatHours(e?.minutes ?? 0));
    }, [appid]);

    if (!api?.enabled()) return null;

    const commit = () => {
        const minutes = parseHours(text);
        if (minutes === undefined) {
            setStatus("Type the hours as a number, e.g. 12.5");
            return;
        }
        if (minutes === (entry?.minutes ?? 0)) return;
        setStatus("Saving...");
        void api
            .set(appid, minutes)
            .then((e) => {
                setEntry(e);
                setText(formatHours(e?.minutes ?? minutes));
                setStatus("✓ Saved. Steam's Play Time shows it on the game's page.");
            })
            .catch((err) => setStatus(String(err?.message ?? err)));
    };

    const last = entry?.last_played ? new Date(entry.last_played * 1000).toLocaleString() : "Not played since tracking started";
    return (
        <Card>
            <ItemRow>
                <Field
                    label="Playtime"
                    description={`Counted while the game runs from Steam. Last played: ${last}${entry?.two_weeks ? `; ${formatHours(entry.two_weeks)} h in the last two weeks` : ""}.`}
                    bottomSeparator="none"
                />
            </ItemRow>
            <TextRows label="Total hours" description="Set it by hand for time played before tracking started" value={text} onChange={setText} onCommit={commit} />
            {status && <ActionRow message={status} />}
        </Card>
    );
}
