// app/game-editor: the Game Data editor's use cases (features plan F1). The settings popup reaches this
// only through settings/context.ts. Every write goes to the backend (our own files); Steam is updated by
// the existing surfaces, which re-render from record.metadata / record.identity (never from here, D5).
import type { ShortcutId } from "../kernel/appid";
import { toShortcutId } from "../kernel/appid.ts";
import type { GameMetadata, Identity, Part, RecordStore, Route } from "../kernel/record";
import type { backend as Backend, IgdbCandidate, StoreCandidate, StoreMapping } from "../ports/backend";
import { applyDraft, type MetadataDraft } from "../domain/metadata-edit.ts";

export interface EditorSnapshot {
    appid: number;
    title: string;
    /** What Game Info shows now; a bare { appid, title } while the game has no metadata yet. */
    metadata: GameMetadata;
    hasMetadata: boolean;
    /** A manual edit is stored (Revert is available). */
    custom: boolean;
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
    searchIgdb(term: string): Promise<{ candidates: IgdbCandidate[]; error?: string }>;
    linkIgdb(appid: number, igdbId: number, title?: string): Promise<{ error?: string }>;
}

export interface GameEditorDeps {
    backend: Pick<typeof Backend, "saveCustomMetadata" | "clearCustomMetadata" | "steamStoreSearchCandidates" | "steamStoreGetMapping" | "igdbSearch" | "igdbLink">;
    records: RecordStore;
    ensureBase(appid: ShortcutId): void;
    titleOf(appid: number): string | undefined;
    routeOf(appid: number): Route;
    metadata: { ensure(appid: ShortcutId, route: Route, identity: Part<Identity> | undefined): Promise<Part<GameMetadata>> };
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
            const { metadata, hasMetadata } = currentOf(id);
            const mapping = await deps.backend.steamStoreGetMapping(id).catch(() => null);
            return {
                appid: id,
                title: deps.titleOf(id) ?? metadata.title,
                metadata,
                hasMetadata,
                custom: metadata.custom_override === true,
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
            await deps.metadata.ensure(id, deps.routeOf(id), deps.records.get(id)?.identity);
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

        async searchIgdb(term) {
            const res = await deps.backend.igdbSearch(term);
            return { candidates: res.candidates ?? [], error: res.error };
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
    };
}
