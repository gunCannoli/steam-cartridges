// app/game-editor: the Game Data editor's use cases (features plan F1). The settings popup reaches this
// only through settings/context.ts. Every write goes to the backend (our own files); Steam is updated by
// the existing surfaces, which re-render from record.metadata / record.identity (never from here, D5).
import type { ShortcutId } from "../kernel/appid";
import { toShortcutId } from "../kernel/appid.ts";
import type { GameMetadata, Identity, Part, RecordStore, Route } from "../kernel/record";
import type { backend as Backend, StoreCandidate, StoreMapping } from "../ports/backend";
import { applyDraft, type MetadataDraft } from "../domain/metadata-edit.ts";

/** A game found by id, shown for the user to confirm before it is saved (ADR-0079). */
export interface LinkPreview {
    title: string;
    /** Platforms, year, developers: enough to tell versions apart. */
    details: string;
}

/** The confirmation line of a fetched record. */
export function previewOf(meta: GameMetadata): LinkPreview {
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
    const year = typeof meta.release_date === "number" && meta.release_date > 0 ? String(new Date(meta.release_date * 1000).getUTCFullYear()) : undefined;
    const parts = [list(meta.platforms).slice(0, 2).join(", "), year, list(meta.developers).slice(0, 2).join(", ")].filter((x) => !!x);
    return { title: meta.matched_title || meta.title || "Untitled", details: parts.join(" · ") };
}

export interface EditorSnapshot {
    appid: number;
    title: string;
    /** What Game Info shows now; a bare { appid, title } while the game has no metadata yet. */
    metadata: GameMetadata;
    hasMetadata: boolean;
    /** A manual edit is stored (Revert is available). */
    custom: boolean;
    /** The IGDB or ScreenScraper game the Game Info is linked to (ADR-0087; Revert unlinks it), or null. */
    linked: { source: "igdb" | "screenscraper"; id: number } | null;
    /** The manual or automatic Steam link, or null. */
    link: StoreMapping | null;
    /** Native appids the user chose "never suggest again" for. */
    rejected: number[];
}

export interface GameEditor {
    load(appid: number): Promise<EditorSnapshot>;
    /** Validates, stores as a manual edit, updates the record. Throws Error(message) on an invalid draft. */
    save(appid: number, draft: MetadataDraft): Promise<void>;
    /** Drops the manual edit and re-resolves the game from its sources. */
    revert(appid: number): Promise<void>;
    search(term: string): Promise<{ candidates: StoreCandidate[]; error?: string }>;
    link(appid: number, steamAppid: number, name?: string): Promise<{ error?: string }>;
    /** reject = also remember the native app as "never suggest again". */
    unlink(appid: number, reject: boolean): Promise<{ error?: string }>;
    linkIgdb(appid: number, igdbId: number, title?: string): Promise<{ error?: string }>;
    /** The IGDB game of an id, not saved. */
    previewIgdb(appid: number, igdbId: number): Promise<{ game?: LinkPreview; error?: string }>;
    linkScreenscraper(appid: number, ssId: number, title?: string): Promise<{ error?: string }>;
    /** The ScreenScraper game of an id, not saved. */
    previewScreenscraper(appid: number, ssId: number): Promise<{ game?: LinkPreview; error?: string }>;
    /** Forgets what the plugin fetched or learned about one game; the session's copies go too. Throws on a backend error. */
    deleteMetadata(appid: number): Promise<void>;
}

export interface GameEditorDeps {
    backend: Pick<typeof Backend, "saveCustomMetadata" | "clearCustomMetadata" | "steamStoreSearchCandidates" | "steamStoreGetMapping" | "igdbLink" | "screenscraperLink" | "deleteGameMetadata">;
    records: RecordStore;
    ensureBase(appid: ShortcutId): void;
    titleOf(appid: number): string | undefined;
    routeOf(appid: number): Route;
    metadata: { ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined, opts?: { userAction?: boolean }): Promise<Part<GameMetadata>> };
    /** app/identity: a game whose page was not opened this session has no identity in its record yet. */
    identity: { ensure(appid: ShortcutId, route: Route): Promise<Part<Identity>> };
    /** app/steam-store.ts setSteamStoreMapping / clearSteamStore (they re-run identity, metadata and artwork). */
    steamStore: {
        setMapping(appid: number, steamAppid: number, name?: string): Promise<{ mapping?: unknown; error?: string }>;
        clear(appid: number, reject: boolean): Promise<{ error?: string }>;
    };
}

export function createGameEditor(deps: GameEditorDeps): GameEditor {
    function shortcut(appid: number): ShortcutId {
        const id = toShortcutId(appid);
        if (id === undefined) throw new Error(`Not a non-Steam shortcut: ${appid}`);
        return id;
    }

    /** The stored metadata of a shortcut, or a bare record to edit from scratch. */
    function currentOf(id: ShortcutId): { metadata: GameMetadata; hasMetadata: boolean } {
        const data = deps.records.get(id)?.metadata?.data;
        if (data) return { metadata: data, hasMetadata: true };
        return { metadata: { appid: id, title: deps.titleOf(id) ?? "" }, hasMetadata: false };
    }

    return {
        async load(appid) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const mapping = await deps.backend.steamStoreGetMapping(id).catch(() => null);
            let { metadata, hasMetadata } = currentOf(id);
            // A game whose Game Info the backend holds but this session never read (confirmed a moment ago, or matched to Steam before it was
            // filled in on the spot, ADR-0100): read it now, so the form opens with its fields, not empty.
            if (!hasMetadata) {
                try {
                    const route = deps.routeOf(id);
                    const identity = deps.records.get(id)?.identity ?? (route.bucket === "steam-store" ? await deps.identity.ensure(id, route) : undefined);
                    await deps.metadata.ensure(id, route, identity, { userAction: true });
                    ({ metadata, hasMetadata } = currentOf(id));
                } catch {
                    /* the form opens empty, as before */
                }
            }
            return {
                appid: id,
                title: deps.titleOf(id) ?? metadata.title,
                metadata,
                hasMetadata,
                custom: metadata.custom_override === true,
                linked: metadata.linked ?? null,
                link: mapping?.mapping ?? null,
                rejected: mapping?.rejected ?? [],
            };
        },

        async save(appid, draft) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const next = applyDraft(currentOf(id).metadata, draft); // throws on an invalid draft
            const res = await deps.backend.saveCustomMetadata(id, next);
            if (res.error || !res.part) throw new Error(res.error ?? "Could not save.");
            deps.records.update(id, { metadata: res.part });
        },

        async revert(appid) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const res = await deps.backend.clearCustomMetadata(id);
            if (res.error) throw new Error(res.error);
            // A Steam-routed game asks its identity first, as its page does: without one the backend answers from disk
            // only, and the reverted game would stay empty until its page opens (seen live 2026-10-22, ADR-0087).
            const route = deps.routeOf(id);
            const identity = deps.records.get(id)?.identity ?? (route.bucket === "steam-store" ? await deps.identity.ensure(id, route) : undefined);
            await deps.metadata.ensure(id, route, identity, { userAction: true });
        },

        async search(term) {
            const res = await deps.backend.steamStoreSearchCandidates(term);
            return { candidates: res.candidates ?? [], error: res.error };
        },

        async link(appid, steamAppid, name) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const res = await deps.steamStore.setMapping(id, steamAppid, name);
            return { error: res.error };
        },

        async unlink(appid, reject) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const res = await deps.steamStore.clear(id, reject);
            return { error: res.error };
        },

        async linkIgdb(appid, igdbId, title) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const res = await deps.backend.igdbLink(id, igdbId, title);
            if (res.error) return { error: res.error };
            if (res.metadata) {
                deps.records.update(id, { metadata: { status: "ok", data: res.metadata, source: "igdb" } });
            }
            return {};
        },

        async previewIgdb(appid, igdbId) {
            const id = shortcut(appid);
            const res = await deps.backend.igdbLink(id, igdbId, deps.titleOf(id), true);
            if (res.error || !res.metadata) return { error: res.error ?? "No IGDB game has this id." };
            return { game: previewOf(res.metadata) };
        },

        async previewScreenscraper(appid, ssId) {
            const id = shortcut(appid);
            const res = await deps.backend.screenscraperLink(id, ssId, deps.titleOf(id), true);
            if (res.error || !res.metadata) return { error: res.error ?? "No ScreenScraper game has this id." };
            return { game: previewOf(res.metadata) };
        },

        async linkScreenscraper(appid, ssId, title) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const res = await deps.backend.screenscraperLink(id, ssId, title ?? deps.titleOf(id));
            if (res.error) return { error: res.error };
            if (res.metadata) {
                deps.records.update(id, { metadata: { status: "ok", data: res.metadata, source: "screenscraper" } });
            }
            return {};
        },

        async deleteMetadata(appid) {
            const id = shortcut(appid);
            deps.ensureBase(id);
            const res = await deps.backend.deleteGameMetadata(id);
            if (res.error) throw new Error(res.error);
            // The backend forgot the stored copy: the session's parts go too, so the form, the counts and the setup list agree at once.
            deps.records.update(id, { metadata: undefined, achievements: undefined, media: undefined, identity: undefined, provided: undefined });
        },
    };
}
