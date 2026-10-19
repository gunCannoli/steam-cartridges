// app/records: the one place a GameRecord is created (migration plan M4c).
import type { ShortcutId } from "../kernel/appid";
import { toGameId } from "../kernel/appid";
import type { EventBus } from "../kernel/events";
import { createRecordStore, type RecordStore } from "../kernel/record";

/**
 * One read shared by every caller (ADR-0060): the start-up preloads (metadata, achievements) both need every stored
 * record, and each GetAllRecords is megabytes through a host that serves one call at a time. A failed read is tried
 * again by the next caller.
 */
export function sharedRead<T>(read: () => Promise<T>): () => Promise<T> {
    let once: Promise<T> | undefined;
    return () => {
        once ??= read().catch((err) => {
            once = undefined;
            throw err;
        });
        return once;
    };
}

export function createRecords(bus: EventBus): { store: RecordStore; ensureBase(appid: ShortcutId, title: string): void } {
    const store = createRecordStore(bus);
    return {
        store,
        ensureBase(appid, title) {
            store.upsert({ appid, gameid: toGameId(appid), title, exe: "" });
        },
    };
}
