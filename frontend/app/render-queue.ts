// app/render-queue: coalesces record.updated events into one render per appid
// per tick (migration plan M4c, plan § 7.0 D5 — never render from inside a
// Steam render, always on a timer after the signal).
import type { ShortcutId } from "../kernel/appid";
import type { RecordPart } from "../kernel/record";

export interface RenderQueue {
    push(appid: ShortcutId, parts: RecordPart[]): void;
}

export function createRenderQueue(
    render: (appid: ShortcutId, parts: RecordPart[]) => void,
    schedule: (f: () => void) => void = (f) => setTimeout(f, 0),
): RenderQueue {
    const pending = new Map<ShortcutId, Set<RecordPart>>();
    let flushScheduled = false;

    function flush(): void {
        flushScheduled = false;
        const batch = [...pending];
        pending.clear();
        for (const [appid, parts] of batch) render(appid, [...parts]);
    }

    return {
        push(appid, parts) {
            let set = pending.get(appid);
            if (!set) pending.set(appid, (set = new Set()));
            for (const p of parts) set.add(p);
            if (!flushScheduled) {
                flushScheduled = true;
                schedule(flush);
            }
        },
    };
}
