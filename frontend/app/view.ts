// app/view: what happens when the user opens a shortcut's page (migration plan M7b; moved from
// features/source-view.ts, the last features/ file of the pipeline). ADR-0060: paint from disk, then refresh.
//   1. Game Info and achievements as stored on disk (`noNetwork`), so a known game's page fills at once;
//   2. the Steam match (every refresh reads it; what an extension pushed is on disk, ADR-0067);
//   3. a source is asked only for a part that is missing or due (the backend marks it `stale`; its TTLs in
//      fresh_policy.lua decide), Game Info first, then achievements, then artwork and community media.
// The Lua host serves one call at a time, so the order of the calls is the order of the page filling in; the
// calls' lanes (ports/transport) keep background work behind them. A Steam render never starts a view (M0a):
// views come from sensors/view.
import { toShortcutId, type ShortcutId } from "../kernel/appid.ts";
import type { ArtworkPlan, GameMetadata, Identity, Part, Route } from "../kernel/record";

export interface ViewDeps {
    routing: {
        getBucket(appid: number): Route;
        waitForCollections(timeoutMs?: number): Promise<boolean>;
    };
    identity: { ensure(appid: ShortcutId, route: Route): Promise<Part<Identity>> };
    metadata: {
        ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined, opts?: { noNetwork?: boolean }): Promise<Part<GameMetadata>>;
    };
    artwork: { ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined): Promise<Part<ArtworkPlan>> };
    achievements: { ensure(appid: ShortcutId, route: Route, opts?: { noNetwork?: boolean }): Promise<Part<unknown> | void> };
    /** Community media (features plan F2); runs after metadata, whose igdb_id it reads from the record. */
    media: { ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined): Promise<unknown> };
}

export interface View {
    /** Route a view of a shortcut to the parts its bucket allows (ADR-0033). */
    onSourceView(appid: number): Promise<void>;
    /** Replay the views that arrived before collections were ready. */
    init(): void;
}

/** A painted part that still needs its source: nothing answered, nothing stored yet, due for a refresh, or a failed call. */
export function needsRefresh(part: Part<unknown> | void | undefined): boolean {
    if (!part) return true;
    if (part.stale === true) return true;
    return part.status === "error" && part.data === undefined;
}

export function createView(deps: ViewDeps): View {
    /** Appids currently being dispatched (desktop and Big Picture can both fire). */
    const inflight = new Set<number>();
    /** Views seen before collections were ready; replayed once they are. */
    const deferred = new Set<number>();
    /** A view that arrived while the same appid was in flight; replayed once afterwards (P4 H6). */
    const rerun = new Set<number>();

    async function onSourceView(appid: number): Promise<void> {
        const id = toShortcutId(appid);
        if (id === undefined) return;
        if (inflight.has(id)) {
            rerun.add(id);
            return;
        }
        inflight.add(id);
        try {
            const { bucket, via } = deps.routing.getBucket(id);
            const route: Route = { bucket, via };
            if (via === "pending") {
                // Local Game Info and stored achievements only until collections load (ADR-0035); replayed then.
                deferred.add(id);
                await Promise.all([
                    deps.metadata.ensure(id, route, undefined),
                    deps.achievements.ensure(id, route, { noNetwork: true }),
                ]);
                return;
            }
            if (bucket === "none") {
                // ADR-0035: no network; each part answers from disk or "unsupported".
                await deps.metadata.ensure(id, route, undefined);
                await deps.artwork.ensure(id, route, undefined);
                void deps.media.ensure(id, route, undefined);
                void deps.achievements.ensure(id, route);
                return;
            }

            // 1. Paint: what is stored, one short disk-only call each (ADR-0060).
            const [meta, ach] = await Promise.all([
                deps.metadata.ensure(id, route, undefined, { noNetwork: true }),
                deps.achievements.ensure(id, route, { noNetwork: true }),
            ]);

            // 2. For the steam-store bucket, the Steam match (ADR-0036). The backend's metadata, media and achievements read
            //    it, and what an extension pushed (ADR-0067, on disk).
            const identityPart = bucket === "steam-store" ? await deps.identity.ensure(id, route) : undefined;

            // 3. Refresh what is missing or due. A Steam match's Game Info comes from Steam's own store item, which
            //    is never stored, so it is always asked (no network when Steam has the item).
            const native = identityPart?.data?.native !== undefined;
            const metaDone = needsRefresh(meta) || native ? deps.metadata.ensure(id, route, identityPart) : Promise.resolve(meta);
            const achDone = needsRefresh(ach) ? deps.achievements.ensure(id, route) : Promise.resolve(ach);
            await metaDone;
            await deps.artwork.ensure(id, route, identityPart);
            void deps.media.ensure(id, route, identityPart); // a Steam match keeps Steam's own community content
            void achDone.catch(() => undefined); // queued before artwork and media, in the view lane
        } finally {
            inflight.delete(id);
            if (rerun.delete(id)) void onSourceView(id);
        }
    }

    return {
        onSourceView,
        init() {
            void deps.routing.waitForCollections().then(() => {
                const list = [...deferred];
                deferred.clear();
                list.forEach((a) => void onSourceView(a));
            });
        },
    };
}
