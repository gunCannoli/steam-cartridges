// Steam's React Query clients, and the data a shortcut needs in them.
//
// Steam keeps moving app-page data from MobX stores to React Query (Steam 1794424036, stable 2026-11). For a shortcut its own
// fetches answer "nothing" (store item `{visible:false}`, achievements error / empty), so the components that read the
// queries render nothing:
//  - the Activity feed's event card reads `["StoreItem", "app_<appid>", "default_info"]` and needs `visible`;
//  - the Achievements section reads `["achievements", appid, "schema" | "globalpercentages" | "user_achievements", steamid]`.
// We write our data under those keys ("pin" it) and put it back whenever Steam writes its own over it (a cache subscription),
// in every client found: each Steam window's React tree may sit under its own QueryClientProvider (Big Picture).
//
// A client is not exported (steam-components.md): it is the `client` prop of a fiber above any rendered element.

interface Query {
    queryKey: unknown[];
    state: { data?: any };
}
export interface QueryClientLike {
    getQueryCache(): { getAll(): Query[]; subscribe(cb: (e: { type: string; query: Query }) => void): () => void };
    setQueryData(key: unknown[], data: unknown): unknown;
    setQueryDefaults?(key: unknown[], options: Record<string, unknown>): void;
}

const STORE_ITEM = "StoreItem";
const DEFAULT_INFO = "default_info";

const clients = new Set<QueryClientLike>();
const subscribed = new WeakSet<QueryClientLike>();
/** Shortcut appid -> the name its seeded store item carries. */
const seeded = new Map<number, string>();
/** JSON of a query key -> the data we pinned there. */
const pinned = new Map<string, unknown>();

function isClient(v: any): v is QueryClientLike {
    return !!v && typeof v.getQueryCache === "function" && typeof v.setQueryData === "function";
}

/** The client above one DOM element of a React tree, if any. */
function clientAbove(el: Element): QueryClientLike | undefined {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    for (let f = key ? (el as any)[key] : undefined, n = 0; f && n < 400; f = f.return, n++) {
        const p = f.memoizedProps;
        if (isClient(p?.client)) return p.client;
        if (isClient(p?.value)) return p.value;
    }
    return undefined;
}

/** Every Steam QueryClient reachable now (one per window's React tree, often the same one), added to those seen before. */
export function steamQueryClients(): QueryClientLike[] {
    const docs: Document[] = [];
    try {
        const windows = (globalThis as any).SteamUIStore?.WindowStore?.SteamUIWindows ?? [];
        for (const w of windows) if (w?.BrowserWindow?.document) docs.push(w.BrowserWindow.document);
    } catch {
        /* no window store */
    }
    if (typeof document !== "undefined") docs.push(document);
    for (const doc of docs) {
        let tried = 0;
        for (const el of doc.querySelectorAll("div")) {
            if (!Object.keys(el).some((k) => k.startsWith("__reactFiber"))) continue;
            const c = clientAbove(el);
            if (c) {
                clients.add(c);
                break;
            }
            if (++tried > 20) break;
        }
    }
    for (const c of clients) watch(c);
    return [...clients];
}

/** The first client found (kept for callers that need one). */
export function steamQueryClient(): QueryClientLike | undefined {
    return steamQueryClients()[0];
}

/** The store item a shortcut gets: StoreBrowse's default_info shape, visible, a game (type 0). */
export function shortcutStoreItem(appid: number, name: string): Record<string, unknown> {
    return {
        item_type: 0,
        id: appid,
        success: 1,
        visible: true,
        name,
        store_url_path: "",
        store_url_slug: "",
        appid,
        type: 0,
        included_types: [],
        included_appids: [],
        content_descriptorids: [],
    };
}

/** `["StoreItem", "app_<appid>", "default_info", scope?]` -> appid, else undefined. */
export function defaultInfoAppid(key: unknown[]): number | undefined {
    if (key?.[0] !== STORE_ITEM || key[2] !== DEFAULT_INFO || typeof key[1] !== "string") return undefined;
    const m = /^app_(\d+)$/.exec(key[1]);
    return m ? Number(m[1]) : undefined;
}

/** JSON of a query key -> JSON of the data we pinned (compared by content: setQueryData shares structure with the old data,
 *  so the stored object is rarely the one we passed; an identity test re-pinned forever and froze SharedJSContext). */
const pinnedJson = new Map<string, string>();
/** Repairs per key in the current window, and keys we gave up on (a loop brake: Steam and we must not fight forever). */
const repairs = new Map<string, { n: number; since: number }>();
const gaveUp = new Set<string>();
let onGiveUp: (key: string) => void = () => {};

/** Where the brake reports a key it stopped repairing (the caller logs it once). */
export function onPinGivenUp(cb: (key: string) => void): void {
    onGiveUp = cb;
}

/** True when `k` may be repaired once more: at most 5 repairs per key per 10 s, then never again this session. */
function mayRepair(k: string): boolean {
    if (gaveUp.has(k)) return false;
    const now = Date.now();
    const r = repairs.get(k);
    if (!r || now - r.since > 10_000) {
        repairs.set(k, { n: 1, since: now });
        return true;
    }
    if (++r.n <= 5) return true;
    gaveUp.add(k);
    try {
        onGiveUp(k);
    } catch {
        /* diagnostics only */
    }
    return false;
}

/** Is `q` holding something other than what we want there? Then put ours back. */
function repair(c: QueryClientLike, q: Query): void {
    const k = JSON.stringify(q.queryKey);
    const want = pinned.get(k);
    if (want !== undefined) {
        if (q.state.data === want || JSON.stringify(q.state.data) === pinnedJson.get(k)) return;
        if (mayRepair(k)) c.setQueryData(q.queryKey, want);
        return;
    }
    const id = defaultInfoAppid(q.queryKey);
    const name = id === undefined ? undefined : seeded.get(id);
    if (id === undefined || name === undefined) return;
    if (q.state.data?.visible === true && q.state.data?.name === name) return;
    if (mayRepair(k)) c.setQueryData(q.queryKey, shortcutStoreItem(id, name));
}

/** Steam's own fetch (on a later mount, or once stale) writes its answer back: put ours back. */
function watch(c: QueryClientLike): void {
    if (subscribed.has(c)) return;
    subscribed.add(c);
    c.getQueryCache().subscribe((e) => {
        if (e?.type !== "updated" && e?.type !== "added") return;
        const q = e.query;
        if (!q) return;
        const k = JSON.stringify(q.queryKey);
        if (!pinned.has(k) && (defaultInfoAppid(q.queryKey) === undefined || !seeded.has(defaultInfoAppid(q.queryKey)!))) return;
        queueMicrotask(() => {
            try {
                repair(c, q);
            } catch {
                /* the next pin writes it again */
            }
        });
    });
}

/**
 * Write `data` under `key` in every client and keep it there. Returns the number of clients written to (0: none found, a Steam
 * build that moved them; the caller logs it).
 */
export function pinQueryData(key: unknown[], data: unknown, keepPrefix?: unknown[]): number {
    const k = JSON.stringify(key);
    const json = JSON.stringify(data);
    if (pinnedJson.get(k) === json && pinned.has(k)) {
        // Same data as last time: write only where a client lost it (no update event, no re-render).
        for (const c of steamQueryClients()) {
            const q = c.getQueryCache().getAll().find((x) => JSON.stringify(x.queryKey) === k);
            if (!q || JSON.stringify(q.state.data) !== json) c.setQueryData(key, data);
        }
        return clients.size;
    }
    pinned.set(k, data);
    pinnedJson.set(k, json);
    gaveUp.delete(k);
    const cs = steamQueryClients();
    for (const c of cs) {
        try {
            // A query nobody watches is dropped after gcTime (5 min by default): keep ours (the hooks set no gcTime).
            if (keepPrefix) c.setQueryDefaults?.(keepPrefix, { gcTime: Infinity });
            c.setQueryData(key, data);
        } catch {
            /* one client failing leaves the others */
        }
    }
    return cs.length;
}

/** Forget a pinned key (the data is left; Steam's next fetch replaces it). */
export function unpinQueryData(key: unknown[]): void {
    pinned.delete(JSON.stringify(key));
    pinnedJson.delete(JSON.stringify(key));
}

/**
 * Make Steam's feed treat a shortcut as a visible game. Returns `ok`, or `no-client` when no QueryClient was found (the feed
 * then shows empty days again).
 */
export function seedShortcutStoreItem(appid: number, name: string): "ok" | "no-client" {
    const cs = steamQueryClients();
    if (cs.length === 0) return "no-client";
    seeded.set(appid, name);
    const base = [STORE_ITEM, `app_${appid}`];
    for (const c of cs) {
        try {
            c.setQueryDefaults?.(base, { gcTime: Infinity });
        } catch {
            /* defaults are an optimisation */
        }
        c.setQueryData([...base, DEFAULT_INFO], shortcutStoreItem(appid, name));
        // Any other scope Steam already made for it (a cache scope can be added to the key).
        for (const q of c.getQueryCache().getAll()) if (defaultInfoAppid(q.queryKey) === appid) repair(c, q);
    }
    return "ok";
}
