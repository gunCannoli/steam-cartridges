// The only way settings panels reach the app (migration plan M8b, § 7.0 D3): `index.tsx` calls
// setPanelContext() at the top of init(); panels read it with usePanelContext(). Structural types only,
// never an import of app/, surfaces/ or features/. Backend calls go through ports/backend.ts.
import type { AutoRoutingProfile, ServiceTarget } from '../domain/routing/policy';
import type { MetadataDraft } from '../domain/metadata-edit';
import type { GameMetadata, SyncProgress } from '../kernel/record';
import type { IgdbCandidate, StoreCandidate, StoreMapping } from '../ports/backend';

/** Structural copy of app/game-editor.ts EditorSnapshot (settings never import app/; index.tsx checks the match). */
export interface EditorSnapshot {
    appid: number;
    title: string;
    metadata: GameMetadata;
    hasMetadata: boolean;
    custom: boolean;
    link: StoreMapping | null;
    rejected: number[];
}

export interface PanelContext {
    routing: {
        listCollections(): { id: string; name: string; dynamic: boolean; shortcutCount: number }[];
        listShortcuts(): { appid: number; name: string }[];
        membersOf(id: string): ReadonlySet<number> | undefined;
        shortcutName(appid: number): string;
        getAutoRoutingProfile(appid: number): AutoRoutingProfile | undefined;
        /** Do the routing rules and Auto Mode allow `service` for this shortcut? (app/routing) */
        serviceAllowed(service: ServiceTarget, appid: number): boolean;
        /** Re-read the auto-routing profiles from the backend (the audit does this before each render). */
        reloadProfiles(): Promise<void>;
    };
    ingest: {
        progress(): SyncProgress;
        onProgress(fn: (p: SyncProgress) => void): () => void;
        trigger(delayMs?: number): void;
        start(opts?: { forceAll?: boolean; onlyAppids?: number[] }): Promise<void>;
    };
    records: {
        achievementsOf(appid: number): { nAchieved: number; nTotal: number } | undefined;
        refreshAchievements?(appid: number): Promise<void>;
    };
    controller: {
        load(): Promise<void>;
        inferredFor(appid: number): boolean | undefined;
        /** Re-derive a game's badges after its controller override changed. */
        refresh(appid: number): void;
    };
    steamStore: { setMapping(appid: number, steamAppid: number, name?: string): Promise<{ mapping?: unknown; error?: string }> };
    editor: {
        load(appid: number): Promise<EditorSnapshot>;
        save(appid: number, draft: MetadataDraft): Promise<void>;
        revert(appid: number): Promise<void>;
        search(term: string): Promise<{ candidates: StoreCandidate[]; error?: string }>;
        link(appid: number, steamAppid: number, name?: string): Promise<{ error?: string }>;
        unlink(appid: number, reject: boolean): Promise<{ error?: string }>;
        searchIgdb(term: string): Promise<{ candidates: IgdbCandidate[]; error?: string }>;
        linkIgdb(appid: number, igdbId: number, title?: string): Promise<{ error?: string }>;
    };
}

const EMPTY_PROGRESS: SyncProgress = { isSyncing: false, total: 0, current: 0, currentGame: '', phase: 'idle' };

/** Inert until index.tsx wires the real one, so a panel opened early renders empty instead of throwing. */
const INERT: PanelContext = {
    routing: {
        listCollections: () => [],
        listShortcuts: () => [],
        membersOf: () => undefined,
        shortcutName: (appid) => String(appid),
        getAutoRoutingProfile: () => undefined,
        serviceAllowed: () => true,
        reloadProfiles: async () => {},
    },
    ingest: { progress: () => EMPTY_PROGRESS, onProgress: () => () => {}, trigger: () => {}, start: async () => {} },
    records: { achievementsOf: () => undefined },
    controller: { load: async () => {}, inferredFor: () => undefined, refresh: () => {} },
    steamStore: { setMapping: async () => ({ error: 'not ready' }) },
    editor: {
        load: async (appid) => ({ appid, title: String(appid), metadata: { appid, title: String(appid) }, hasMetadata: false, custom: false, link: null, rejected: [] }),
        save: async () => {},
        revert: async () => {},
        search: async () => ({ candidates: [] }),
        link: async () => ({ error: 'not ready' }),
        unlink: async () => ({ error: 'not ready' }),
        searchIgdb: async () => ({ candidates: [] }),
        linkIgdb: async () => ({ error: 'not ready' }),
    },
};

let context: PanelContext = INERT;

export function setPanelContext(ctx: PanelContext): void {
    context = ctx;
}

export function usePanelContext(): PanelContext {
    return context;
}
