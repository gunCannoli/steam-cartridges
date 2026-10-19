// app/artwork: decides which art a shortcut gets and puts the plan in its record; the artwork
// surface only executes it (migration plan M5c, D4). One EnsureFresh(["artwork"]) per shortcut per
// session; the pure plan comes from domain/art-plan. M10: this also fetches the slot bytes (into the
// kernel image bin), stores the icon file through the backend before the plan reaches the record,
// and records what the surface reports it wrote (`artwork.applied`); no surface does I/O.
import { logger } from "../logger.ts";
import type { ShortcutId } from "../kernel/appid";
import type { EventBus, Events } from "../kernel/events";
import type { ImageBin } from "../kernel/image-bin";
import { SLOT_KEYS } from "../kernel/image-bin.ts";
import type { ArtworkPlan, ArtworkUrls, Identity, Part, RecordStore, Route } from "../kernel/record";
import type { backend as Backend } from "../ports/backend";
import { assetUrlsFromItem } from "../domain/store-item.ts";
import { buildPlan, recordedSlots, type RawArtwork } from "../domain/art-plan.ts";
import { createSessionMemo } from "./session-memo.ts";

export interface ArtworkDeps {
    backend: Pick<typeof Backend, "ensureFresh" | "steamStoreSaveIcon" | "steamStoreRecordArtwork" | "steamStoreRecordIcon">;
    records: RecordStore;
    bus: Pick<EventBus, "on">;
    /** Where the fetched slot bytes wait for the artwork surface (kernel/image-bin). */
    images: ImageBin;
    /** Creates the base record if the appid has none yet (app/records.ts ensureBase). */
    ensureBase(appid: ShortcutId): void;
    titleOf(appid: number): string | undefined;
    /** The mapped native's StoreItemCache item (sensors/store-item), for its hashed art URLs. */
    storeItemFor(steamAppid: number): Promise<any | null>;
    /** The image bytes (ports/image); `forcePng` for the logo. */
    fetchImage(url: string, forcePng?: boolean): Promise<{ base64: string; ext: string } | null>;
    /** services.steamgriddbEnabled and the routing rules for "steamgriddb". */
    allowSgdb(appid: ShortcutId): boolean;
    now(): number;
}

export interface ArtworkResolver {
    /** Subscribe to `artwork.applied`: record what the surface wrote, undo it when the backend refuses. */
    install(): void;
    ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined, opts?: { lane?: "background" | "normal" }): Promise<Part<ArtworkPlan>>;
    /** Drop this session's memory so the next ensure asks the backend again. */
    invalidate(appid: ShortcutId): void;
    /**
     * Ask the surface to clear these slots (Clear / re-map), and to put the library icon back
     * when `iconRestore` is given (icon plan); the backend already forgot them.
     */
    clearSlots(appid: ShortcutId, slots: number[], iconRestore?: string): void;
}

export function createArtwork(deps: ArtworkDeps): ArtworkResolver {
    /** One lookup per appid per session (app/session-memo.ts); only ok and unsupported are final. */
    const memo = createSessionMemo<ArtworkPlan>();

    /** The bytes of every slot the plan writes, into the bin (a slot that fails is left out: the surface reports it failed). */
    async function fetchSlots(appid: ShortcutId, plan: ArtworkPlan): Promise<void> {
        deps.images.discard(appid);
        await Promise.all(
            plan.write.map(async (slot) => {
                const key = SLOT_KEYS[slot];
                const url = key ? plan.urls[key as keyof ArtworkUrls] : undefined;
                if (!key || !url) return;
                const image = await deps.fetchImage(url, slot === 2).catch(() => null);
                if (image) deps.images.put(appid, key, image);
                else logger.warn(`Artwork ${appid}: ${key} image not fetched`);
            }),
        );
    }

    /** Store the icon file through the backend (refused unless still eligible); the plan gets its path. The 32 px
     *  `fallback` is fetched when the 184 px `url` is not served (a 404 on Steam's CDN for some apps). */
    async function storeIcon(appid: ShortcutId, first: string, plan: ArtworkPlan, fallback?: string): Promise<ArtworkPlan["icon"]> {
        let url = first;
        let image = await deps.fetchImage(url).catch(() => null);
        if (!image && fallback) {
            url = fallback;
            image = await deps.fetchImage(url).catch(() => null);
        }
        if (!image) {
            logger.warn(`Artwork ${appid}: library icon not fetched`);
            return undefined;
        }
        const source = plan.source === "steamgriddb" ? "steamgriddb" : "steam-cdn";
        const saved = await deps.backend.steamStoreSaveIcon(appid, url, source, plan.steamAppid, image.base64).catch(() => null);
        if (!saved?.path || saved.error) {
            logger.warn(`Artwork ${appid}: library icon not stored: ${saved?.error ?? "no response"}`);
            return undefined;
        }
        return { path: saved.path, previous: saved.previous ?? "" };
    }

    async function resolve(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined, opts?: { lane?: "background" | "normal" }): Promise<Part<ArtworkPlan>> {
        if (route.bucket === "none") {
            const part: Part<ArtworkPlan> = { status: "unsupported" };
            deps.records.update(appid, { artwork: part });
            return part;
        }
        // steam-store: wait until identity is known (the backend would say pending too).
        if (route.bucket === "steam-store" && (!identity || identity.status === "pending" || identity.status === "error")) {
            return { status: "pending" };
        }

        const native = identity?.data?.native?.appid;
        let artUrls: ArtworkUrls | undefined;
        if (native !== undefined) {
            const item = await deps.storeItemFor(native);
            if (item) artUrls = assetUrlsFromItem(item);
        }

        const res = await deps.backend.ensureFresh(appid, ["artwork"], {
            title: deps.titleOf(appid) ?? "",
            route,
            identity,
            artUrls,
            allowSgdb: deps.allowSgdb(appid),
        }, opts);
        const raw = res.error ? undefined : (res.parts.artwork as Part<RawArtwork> | undefined);

        let part: Part<ArtworkPlan>;
        if (raw?.status === "ok" && raw.data) {
            const { plan, iconUrl, iconFallback } = buildPlan(raw.data, deps.now());
            // The bytes and the icon file exist before the plan reaches the record (and the surface).
            await fetchSlots(appid, plan);
            if (iconUrl) {
                const icon = await storeIcon(appid, iconUrl, plan, iconFallback);
                if (icon) plan.icon = icon;
            }
            part = { status: "ok", source: raw.source, checkedAt: raw.checkedAt, data: plan };
        } else if (raw) {
            const { data: _drop, ...rest } = raw;
            part = rest as Part<ArtworkPlan>;
        } else {
            part = { status: "error", message: res.error ?? "no artwork part" };
        }
        logger.info(`Artwork ${appid}: ${part.status} ${part.data ? `${part.data.source} write=[${part.data.write}]` : "-"}`);
        deps.records.update(appid, { artwork: part });
        return part;
    }

    function clearSlots(appid: ShortcutId, slots: number[], iconRestore?: string): void {
        if (slots.length === 0 && iconRestore === undefined) return;
        deps.ensureBase(appid);
        const plan: ArtworkPlan = { source: "cleared", urls: {}, write: [], clear: slots, tried: [], kept: [], at: deps.now() };
        if (iconRestore !== undefined) plan.icon = { restore: iconRestore };
        deps.records.update(appid, { artwork: { status: "ok", data: plan } });
    }

    /** Tell the backend what was written (steam_store.json); `{ error }` = the match changed meanwhile: undo (P4 H5). */
    async function record(e: Events["artwork.applied"]): Promise<void> {
        if (e.attempted.length > 0) {
            const { slots, failed } = recordedSlots(e.source, e.kept, e.attempted, e.written);
            const res = await deps.backend
                .steamStoreRecordArtwork(e.appid, e.steamAppid, slots, failed, e.source === "steamgriddb" ? { source: "steamgriddb", tried: e.tried } : undefined)
                .catch((err) => {
                    logger.warn(`Artwork ${e.appid}: could not record the written slots`, err);
                    return undefined;
                });
            if (res?.error) {
                clearSlots(e.appid, e.written, e.icon?.previous);
                return;
            }
        }
        if (e.icon) {
            const res = await deps.backend
                .steamStoreRecordIcon(e.appid, { path: e.icon.path, previous: e.icon.previous, source: e.source, steamAppid: e.steamAppid })
                .catch(() => undefined);
            if (res?.error) clearSlots(e.appid, [], e.icon.previous);
        }
    }

    return {
        install() {
            deps.bus.on("artwork.applied", (e) => void record(e));
        },
        async ensure(appid, route, identity, opts) {
            return memo.run(appid, () => resolve(appid, route, identity, opts), () => deps.records.get(appid)?.artwork);
        },
        invalidate(appid) {
            memo.forget(appid);
        },
        clearSlots,
    };
}
