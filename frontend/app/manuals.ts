// app/manuals: a ScreenScraper manual's pages for Steam's image viewer (features plan F2c, ADR-0048). The community
// surface reports that it showed a manual's viewer (`community.manual-opened`); this reads the PDF from the backend in
// chunks (ports/backend GetManualChunk), renders its pages one by one through the injected renderer (ports/pdf) and puts
// them on the manual shelf (kernel/manual-shelf), which the viewer reads. The frontend writes nothing to disk (the
// backend keeps the PDF and the cover for the setting's days, ADR-0051) and no URL of ScreenScraper reaches it. A failure marks the manual failed and nothing else (ADR-0014).
// The card's cover is the manual's first page: when a shortcut's media names a manual (`record.updated`), the first
// page is rendered once per session onto a 16:9 cover and shelved, and the record is announced as updated so the
// community surface shows it. Cover and pages never read the PDF at the same time (one document in the backend).
import type { ShortcutId } from "../kernel/appid";
import type { EventBus } from "../kernel/events";
import type { ManualPage, ManualShelf } from "../kernel/manual-shelf";
import type { RecordPart } from "../kernel/record";
import type { backend as Backend } from "../ports/backend";
import type { PdfDocument, PdfRenderer } from "../ports/pdf";

/** Pages rendered at most (a longer PDF shows its first pages only). */
export const MAX_MANUAL_PAGES = 200;
/** Chunks read at most: 48 x 1 MiB, the backend's own size cap (screenscraper_media.MAX_MANUAL_BYTES). */
export const MAX_MANUAL_CHUNKS = 48;
/** A page's rendered width in pixels: the Big Picture viewer's width at its device pixel ratio, rounded up. */
export const PAGE_WIDTH = 1400;
/** The card cover's size in pixels: 16:9, drawn at twice the card's layout size (core.MANUAL_CARD_WIDTH). */
export const COVER_WIDTH = 1280;
/** Manual downloads are community content: below the page's own data in the call queue (ADR-0060). */
const MEDIA = { lane: "media" } as const;
export const COVER_HEIGHT = 720;
/** A chunk read is tried again this many times after its RPC fails: the backend's 30 s limit can end the call that downloads the PDF while the download still completes there. */
export const RPC_RETRIES = 2;
/** pdf.js never waits longer than this for one step; a hung document must not hold the queue (ms). */
export const RENDER_TIMEOUT = 90_000;

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)));
    return Promise.race([task, limit]).finally(() => clearTimeout(timer));
}

export interface ManualsDeps {
    backend: Pick<typeof Backend, "getManualChunk"> & Partial<Pick<typeof Backend, "getManualCover" | "saveManualCover">>;
    /** The disk cover cache's two conversions (ports/image); without it every start renders the cover from the PDF. */
    coverCache?: {
        objectUrl(base64: string, ext: string): string | null;
        toBase64(url: string): Promise<string | null>;
    };
    /** Setting mediaCacheDays (ADR-0051): with more than 0 the backend keeps the PDF and the cover on disk. */
    cacheDays?(): number;
    /** Timing lines for the diagnostics log. */
    log?(message: string): void;
    bus: Pick<EventBus, "on" | "emit">;
    shelf: ManualShelf;
    renderer: PdfRenderer;
    titleOf(appid: number): string | undefined;
    /** The key of the manual item the shortcut's media shows (the toggle applied), if any. */
    manualKeyOf(appid: number): string | undefined;
}

export interface Manuals {
    /** Subscribe to `community.manual-opened` and `record.updated`. */
    install(): void;
    /** Read, render and shelve one manual. A manual already rendered or rendering is not read again. */
    open(appid: ShortcutId, key: string): Promise<void>;
    /** Render the manual's first page as its card cover, once per session. */
    cover(appid: ShortcutId, key: string): Promise<void>;
}

export function createManuals(deps: ManualsDeps): Manuals {
    const busy = new Set<string>();
    /** Manuals whose cover was tried this session (a failure is not retried on every record update). */
    const covered = new Set<string>();
    /** One manual is read at a time: the backend keeps a single downloaded copy. */
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(task: () => Promise<T>): Promise<T> => {
        const next = queue.then(task, task);
        queue = next.catch(() => {});
        return next;
    };

    /** The last manual read, so the pages after the cover (or the cover after the pages) do not download it again. */
    let held: { id: string; chunks: string[] } | undefined;

    async function readChunk(appid: ShortcutId, key: string, index: number) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await deps.backend.getManualChunk(appid, key, index, deps.titleOf(appid), deps.cacheDays?.() ?? 0, MEDIA);
            } catch (err) {
                if (attempt >= RPC_RETRIES) throw err;
            }
        }
    }

    /** The PDF as base64 chunks in order, or null (an error answer, a gap, or more than MAX_MANUAL_CHUNKS). */
    async function download(appid: ShortcutId, key: string): Promise<string[] | null> {
        const id = `${appid}:${key}`;
        if (held?.id === id) return held.chunks;
        const chunks: string[] = [];
        let total = 1;
        for (let index = 0; index < total; index++) {
            const res = await readChunk(appid, key, index);
            if (!res.base64 || res.index !== index || typeof res.chunks !== "number" || res.chunks > MAX_MANUAL_CHUNKS) return null;
            total = res.chunks;
            chunks.push(res.base64);
        }
        held = { id, chunks };
        return chunks;
    }

    async function openNow(appid: ShortcutId, key: string): Promise<void> {
        const id = `${appid}:${key}`;
        if (busy.has(id) || deps.shelf.get(appid, key)?.status === "ready") return;
        busy.add(id);
        let doc: PdfDocument | null = null;
        try {
            deps.shelf.set(appid, key, { status: "loading", pages: [] });
            const chunks = await download(appid, key);
            doc = chunks ? await withTimeout(deps.renderer.open(chunks), RENDER_TIMEOUT) : null;
            if (!doc || doc.pageCount < 1) {
                deps.shelf.set(appid, key, { status: "failed", pages: [] });
                return;
            }
            const count = Math.min(doc.pageCount, MAX_MANUAL_PAGES);
            let pages: ManualPage[] = Array.from({ length: count }, () => ({ width: doc!.pageWidth, height: doc!.pageHeight }));
            deps.shelf.set(appid, key, { status: "loading", pages });
            // One page at a time, in reading order: the viewer shows each as soon as it is ready.
            for (let n = 1; n <= count; n++) {
                const url = await withTimeout(doc.renderPage(n, PAGE_WIDTH), RENDER_TIMEOUT);
                if (!url) continue;
                pages = pages.slice();
                pages[n - 1] = { ...pages[n - 1]!, url };
                deps.shelf.set(appid, key, { status: "loading", pages });
            }
            deps.shelf.set(appid, key, { status: "ready", pages });
        } catch {
            deps.shelf.set(appid, key, { status: "failed", pages: [] }); // ADR-0014: the viewer says so, nothing else
        } finally {
            doc?.destroy();
            busy.delete(id);
        }
    }

    const open = (appid: ShortcutId, key: string): Promise<void> => {
        const id = `${appid}:${key}`;
        if (busy.has(id)) return Promise.resolve();
        busy.add(id); // set here too: a second open queued behind the first must not read the PDF again
        return serial(async () => {
            busy.delete(id);
            await openNow(appid, key);
        });
    };

    const log = (message: string) => deps.log?.(message);

    /** The cover stored on disk by an earlier start, shelved; false when there is none. */
    async function coverFromDisk(appid: ShortcutId, key: string): Promise<boolean> {
        if (!deps.backend.getManualCover || !deps.coverCache) return false;
        try {
            const res = await deps.backend.getManualCover(appid, key, deps.cacheDays?.() ?? 0, MEDIA);
            const url = res.base64 ? deps.coverCache.objectUrl(res.base64, "jpg") : null;
            if (!url) return false;
            deps.shelf.setCover(appid, key, url);
            deps.bus.emit("record.updated", { appid, parts: ["media"] as RecordPart[] });
            return true;
        } catch {
            return false;
        }
    }

    /** Keep a rendered cover on disk (a disk or RPC error only costs a re-render next start). */
    async function saveCover(appid: ShortcutId, key: string, url: string): Promise<void> {
        if (!deps.backend.saveManualCover || !deps.coverCache) return;
        try {
            const base64 = await deps.coverCache.toBase64(url);
            if (base64) await deps.backend.saveManualCover(appid, key, base64, deps.cacheDays?.() ?? 0, MEDIA);
        } catch {
            /* rendered again next start */
        }
    }

    async function coverNow(appid: ShortcutId, key: string): Promise<void> {
        let doc: PdfDocument | null = null;
        const started = Date.now();
        try {
            const chunks = await download(appid, key);
            doc = chunks ? await withTimeout(deps.renderer.open(chunks), RENDER_TIMEOUT) : null;
            const url = doc ? await withTimeout(doc.renderCover(COVER_WIDTH, COVER_HEIGHT), RENDER_TIMEOUT) : null;
            if (!url) return; // the placeholder cover stays (ADR-0014)
            deps.shelf.setCover(appid, key, url);
            log(`Manual cover ${appid}: rendered from the PDF in ${Date.now() - started} ms`);
            deps.bus.emit("record.updated", { appid, parts: ["media"] as RecordPart[] }); // the community surface re-reads the cover
            void saveCover(appid, key, url);
        } catch {
            /* the placeholder cover stays */
        } finally {
            doc?.destroy();
        }
    }

    const cover = (appid: ShortcutId, key: string): Promise<void> => {
        const id = `${appid}:${key}`;
        if (covered.has(id) || deps.shelf.cover(appid, key)) return Promise.resolve();
        covered.add(id);
        // The disk read is a backend call like any other: it waits in the queue (the backend is a single Lua state).
        return serial(async () => {
            const started = Date.now();
            if (await coverFromDisk(appid, key)) {
                log(`Manual cover ${appid}: from disk in ${Date.now() - started} ms`);
                return;
            }
            await coverNow(appid, key);
        });
    };

    return {
        install() {
            deps.bus.on("community.manual-opened", ({ appid, key }) => void open(appid, key));
            deps.bus.on("record.updated", ({ appid, parts }) => {
                if (!parts.includes("media")) return;
                const key = deps.manualKeyOf(appid);
                if (key) void cover(appid, key);
            });
        },
        open,
        cover,
    };
}
