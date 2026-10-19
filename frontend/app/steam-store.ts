// app/steam-store: the manual Steam Store mapping (settings panel and the public CDP API, D8).
// A factory like every other app/ module (M10, ADR-0044): its collaborators are passed in, it keeps
// no module state and touches no surface. Surfaces follow the record parts the resolvers re-write.
import type { StoreState, backend as Backend } from "../ports/backend";
import type { GameMetadata, Identity, Part, Route } from "../kernel/record";
import type { ShortcutId } from "../kernel/appid";
import { iconRestoreOf, slotList } from "../domain/art-plan";

export interface SteamStoreDeps {
    backend: Pick<typeof Backend, "steamStoreClearMapping" | "steamStoreSetMapping" | "steamStoreGetState">;
    identity: { invalidate(appid: ShortcutId): void; ensure(appid: ShortcutId, route: Route): Promise<Part<Identity>> };
    metadata: { ensure(appid: ShortcutId, route: Route, identity: Part<Identity>): Promise<Part<GameMetadata>> };
    artwork: {
        ensure(appid: ShortcutId, route: Route, identity: Part<Identity>): Promise<unknown>;
        invalidate(appid: ShortcutId): void;
        /** A cleared plan in the record: the artwork surface clears these slots (and restores the icon). */
        clearSlots(appid: ShortcutId, slots: number[], iconRestore?: string): void;
    };
}

export interface SteamStore {
    /** Remove the mapping, clear the art slots (and the icon) this plugin wrote; `reject` remembers the match. */
    clear(appid: number, reject: boolean): ReturnType<typeof Backend.steamStoreClearMapping>;
    /** Manual mapping: saves, then re-resolves identity, metadata and artwork. */
    setMapping(appid: number, steamAppid: number, name?: string): ReturnType<typeof Backend.steamStoreSetMapping>;
    state(): Promise<StoreState>;
}

const MANUAL: Route = { bucket: "steam-store", via: "manual" };

export function createSteamStore(deps: SteamStoreDeps): SteamStore {
    return {
        async clear(appid, reject) {
            const id = appid as ShortcutId;
            const res = await deps.backend.steamStoreClearMapping(appid, reject);
            deps.artwork.clearSlots(id, slotList(res.slots), iconRestoreOf(res));
            deps.identity.invalidate(id);
            deps.artwork.invalidate(id);
            const identity = await deps.identity.ensure(id, MANUAL);
            await deps.metadata.ensure(id, MANUAL, identity);
            return res;
        },
        async setMapping(appid, steamAppid, name) {
            const id = appid as ShortcutId;
            const res = await deps.backend.steamStoreSetMapping(appid, steamAppid, name);
            if (res.mapping) {
                deps.identity.invalidate(id);
                deps.artwork.invalidate(id);
                const identity = await deps.identity.ensure(id, MANUAL);
                await deps.metadata.ensure(id, MANUAL, identity);
                await deps.artwork.ensure(id, MANUAL, identity);
            }
            return res;
        },
        state: () => deps.backend.steamStoreGetState(),
    };
}
