// app/media: community media for a shortcut with no Steam match (features plan F2, ADR-0046). One EnsureFresh call
// for the `media` part (IGDB by the metadata's igdb_id, ScreenScraper keys); the settings toggles pick the items
// (domain/community-media); ScreenScraper images are fetched into the media bin as object URLs before the record
// update, so the community surface renders every card it is given. The backend keeps the downloads on disk for the
// setting's days (ADR-0051); pruneCache drops the games not opened within them. A shortcut with a Steam match keeps Steam's own
// community content (native-links, ADR-0038) and costs no call.
import type { ShortcutId } from "../kernel/appid";
import type { CommunityMedia, Identity, MediaItem, Part, RecordStore, Route } from "../kernel/record";
import type { MediaBin } from "../kernel/media-bin";
import type { backend as Backend } from "../ports/backend";
import { visibleMedia, type MediaToggles } from "../domain/community-media.ts";

export interface MediaDeps {
    backend: Pick<typeof Backend, "ensureFresh" | "getMediaImage"> & Partial<Pick<typeof Backend, "pruneMediaCache">>;
    records: RecordStore;
    /** ScreenScraper images as object URLs (kernel/media-bin); the community surface reads it. */
    bin: MediaBin;
    titleOf(appid: number): string | undefined;
    /** services.igdbEnabled and the routing service check for "igdb". */
    allowWeb(appid: ShortcutId): boolean;
    /** services.screenscraperEnabled and the routing service check for "screenscraper". */
    allowScreenscraper(appid: ShortcutId): boolean;
    /** Settings communityShowTrailers / communityShowArtworks. */
    toggles(): MediaToggles;
    /** ports/image objectUrl: base64 bytes -> a blob: URL, or null. */
    objectUrl(base64: string, ext: string): string | null;
    /** Setting mediaCacheDays (0-30): how long the backend keeps a game's downloads on disk after its page last opened. */
    cacheDays?(): number;
    /** Timing lines for the diagnostics log. */
    log?(message: string): void;
}

/**
 * Backend calls made at the same time. One: the Lua backend is a single state and crashed (Chrono Trigger, 2026-10-01) when
 * image downloads ran in parallel, and again with a manual PDF download beside them, so every backend call waits for the last.
 */
export const IMAGE_CONCURRENCY = 1;

export interface MediaResolver {
    ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined): Promise<Part<CommunityMedia>>;
    /** Delete the downloads of every game not opened within the setting's days (at start-up and when the setting changes). */
    pruneCache(): Promise<void>;
}

export function createMedia(deps: MediaDeps): MediaResolver {
    const cacheDays = () => deps.cacheDays?.() ?? 0;

    /** The item if its image is (or now gets) in the bin; undefined when ScreenScraper could not deliver it. */
    async function withImage(appid: ShortcutId, item: MediaItem): Promise<MediaItem | undefined> {
        if (item.source !== "screenscraper" || item.kind === "manual") return item; // a manual is fetched when opened (app/manuals)
        const key = item.key!;
        const cached = deps.bin.get(appid, key);
        if (cached) return { ...item, width: cached.width ?? item.width, height: cached.height ?? item.height };
        let res;
        try {
            res = await deps.backend.getMediaImage(appid, key, deps.titleOf(appid), cacheDays(), { lane: "media" });
        } catch {
            return undefined; // a failed download drops the card, never the part (ADR-0014)
        }
        if (!res.base64 || !res.ext) return undefined;
        const url = deps.objectUrl(res.base64, res.ext);
        if (!url) return undefined;
        deps.bin.put(appid, key, { url, width: res.width, height: res.height });
        return { ...item, width: res.width ?? item.width, height: res.height ?? item.height };
    }

    let latestAppid: ShortcutId | null = null;

    async function ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined): Promise<Part<CommunityMedia>> {
        latestAppid = appid;
        if (identity?.data?.native) {
            const part: Part<CommunityMedia> = { status: "unsupported", message: "steam" };
            deps.records.update(appid, { media: part });
            return part;
        }
        const res = await deps.backend.ensureFresh(appid, ["media"], {
            title: deps.titleOf(appid) ?? "",
            route,
            identity,
            igdb_id: deps.records.get(appid)?.metadata?.data?.igdb_id,
            allowWeb: deps.allowWeb(appid),
            allowScreenscraper: deps.allowScreenscraper(appid),
            cacheDays: cacheDays(),
        }, { lane: "media" }); // community content may be slow; it never holds the page's own data (ADR-0060)
        const raw = res.error ? undefined : (res.parts.media as Part<CommunityMedia> | undefined);
        let part: Part<CommunityMedia> = raw ?? { status: "error", message: res.error ?? "no media part" };
        if (part.status === "ok" && part.data) {
            const visible = visibleMedia(part.data, deps.toggles());
            const started = Date.now();
            // IMAGE_CONCURRENCY at a time, kept in the record's order.
            const shown: Array<MediaItem | undefined> = new Array(visible.length);
            let next = 0;
            const worker = async () => {
                while (next < visible.length) {
                    if (latestAppid !== appid) {
                        deps.log?.(`Community media ${appid}: view moved away, skipping remaining downloads`);
                        break;
                    }
                    const index = next++;
                    shown[index] = await withImage(appid, visible[index]!);
                }
            };
            await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, visible.length) }, worker));
            const items = shown.filter((item): item is MediaItem => !!item);
            deps.log?.(`Community media ${appid}: ${items.length}/${visible.length} cards, images in ${Date.now() - started} ms`);
            part = { ...part, data: { ...part.data, items } };
        }
        deps.records.update(appid, { media: part });
        return part;
    }

    async function pruneCache(): Promise<void> {
        if (!deps.backend.pruneMediaCache) return;
        try {
            const res = await deps.backend.pruneMediaCache(cacheDays(), { lane: "background" });
            if (res.removed) deps.log?.(`Media cache: removed ${res.removed} game(s) not opened in ${cacheDays()} day(s), kept ${res.kept ?? 0}`);
        } catch {
            /* the next start prunes again (ADR-0014) */
        }
    }

    return { ensure, pruneCache };
}
