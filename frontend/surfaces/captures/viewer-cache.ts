import type { QueryClientLike } from "../../steam/query-client";
import type { SteamScreenshot } from "../../steam/stores";

/**
 * Steam's screenshot viewer does not read the screenshots the summary shows. A click opens `/media/item/screenshot/<id>`, and the
 * viewer looks that id up in Steam's React Query cache, `["screenshots","all"]`, which Steam fills once (from
 * `GetAllAppsLocalScreenshotsRange`) the first time anything needs it and extends only from its own capture notifications.
 * A screenshot taken after that, or one the summary found through `GetScreenshotsInTimeRange` for a shortcut, is not in it, and
 * the viewer answers "There was a problem loading this screenshot" (docs/steam-components.md; found in a Linux log, 2026-11-21).
 *
 * `ensureInViewerCache` adds the missing ones in Steam's own shape (its `O()` converter: id `<gameid>_<hHandle>`). The cache is
 * never created here: if Steam has not built it yet, its first build lists every screenshot already.
 */

const ALL = ["screenshots", "all"];
const LOCAL = ["screenshots", "local"];

/** The viewer's id for a screenshot: Steam's `v()`, the upload handle when there is one, else `<gameid>_<hHandle>`. */
export function viewerId(s: Pick<SteamScreenshot, "strGameID" | "hHandle" | "bUploaded" | "ugcHandle">): string {
    return s.bUploaded && s.ugcHandle ? String(s.ugcHandle) : `${s.strGameID}_${s.hHandle}`;
}

/** Steam's media item for a local screenshot (its `O()`). */
export function mediaItem(s: SteamScreenshot & { strShortcutName?: string }): Record<string, unknown> {
    return {
        type: "screenshot",
        id: viewerId(s),
        local: s,
        nHeight: s.nHeight,
        nWidth: s.nWidth,
        rtCreated: s.nCreated,
        strGameID: s.strGameID,
        strUrl: s.strUrl,
        bUploaded: s.bUploaded,
        strShortcutName: s.strShortcutName,
    };
}

export interface ViewerCacheResult {
    /** Clients that hold the "all" query. */
    clients: number;
    /** Summary screenshots the viewer could not find before this call. */
    missing: number;
    /** Added now. */
    added: number;
    /** Steam has not built the cache (nothing to repair), or no client was found. */
    state: "ok" | "no-client" | "not-built";
}

/** Make every screenshot in `shots` openable by Steam's viewer. */
/** `clients` are Steam's query clients (`steamQueryClients()`; a parameter so a test can pass its own). */
export function ensureInViewerCache(shots: SteamScreenshot[], clients: QueryClientLike[]): ViewerCacheResult {
    const result: ViewerCacheResult = { clients: 0, missing: 0, added: 0, state: "ok" };
    if (shots.length === 0) return result;
    if (clients.length === 0) return { ...result, state: "no-client" };

    for (const client of clients) {
        const query = client.getQueryCache().getAll().find((q) => JSON.stringify(q.queryKey) === JSON.stringify(ALL));
        const data = query?.state.data as { local?: Record<string, unknown>; remote?: unknown; modifiedIDs?: unknown } | undefined;
        if (!data?.local) continue;
        result.clients += 1;

        const absent = shots.filter((s) => !data.local![viewerId(s)]);
        result.missing = Math.max(result.missing, absent.length);
        if (absent.length === 0) continue;

        const local = { ...data.local };
        for (const s of absent) local[viewerId(s)] = mediaItem(s);
        client.setQueryData(ALL, { ...data, local });
        result.added = Math.max(result.added, absent.length);

        // The list the viewer pages through (previous / next) is the other query, newest first.
        const list = client.getQueryCache().getAll().find((q) => JSON.stringify(q.queryKey) === JSON.stringify(LOCAL));
        const listed = list?.state.data as { rgOrder?: string[]; screenshots?: Record<string, any> } | undefined;
        if (listed?.rgOrder && listed.screenshots) {
            const screenshots = { ...listed.screenshots };
            for (const s of absent) screenshots[viewerId(s)] = mediaItem(s);
            const rgOrder = [...new Set([...listed.rgOrder, ...absent.map(viewerId)])].sort(
                (a, b) => (screenshots[b]?.local?.nCreated ?? 0) - (screenshots[a]?.local?.nCreated ?? 0),
            );
            client.setQueryData(LOCAL, { ...listed, rgOrder, screenshots });
        }
    }
    if (result.clients === 0) result.state = "not-built";
    return result;
}

// ---------------------------------------------------------------------------
// Keeping them there, and answering a click
// ---------------------------------------------------------------------------

/** Screenshots the summary showed, by the id Steam's viewer uses and by image address (a click only has the address). */
const knownById = new Map<string, SteamScreenshot>();
const knownByAddress = new Map<string, SteamScreenshot>();

/** Remember what the summary showed, so a click and a Steam refetch can be repaired later. */
export function rememberScreenshots(shots: SteamScreenshot[]): void {
    for (const s of shots) {
        knownById.set(viewerId(s), s);
        if (typeof s.strUrl === "string" && s.strUrl) knownByAddress.set(s.strUrl, s);
    }
}

/** The remembered screenshot whose image is at `url` (an <img>'s resolved address may differ by a query string). */
export function knownScreenshot(url: string): SteamScreenshot | undefined {
    if (!url) return undefined;
    const exact = knownByAddress.get(url);
    if (exact) return exact;
    const bare = url.split("?")[0];
    for (const [address, shot] of knownByAddress) if (address.split("?")[0] === bare) return shot;
    return undefined;
}

/** Does any client's viewer cache hold this screenshot? `undefined` when no client has built the cache. */
export function inViewerCache(shot: SteamScreenshot, clients: QueryClientLike[]): boolean | undefined {
    let seen = false;
    for (const client of clients) {
        const data = client.getQueryCache().getAll().find((q) => JSON.stringify(q.queryKey) === JSON.stringify(ALL))?.state.data as
            | { local?: Record<string, unknown> }
            | undefined;
        if (!data?.local) continue;
        seen = true;
        if (data.local[viewerId(shot)]) return true;
    }
    return seen ? false : undefined;
}

const watched = new WeakSet<object>();
const repairs = { n: 0, since: 0 };
let giveUp: (() => void) | undefined;

/** Called once if the repair below loses a fight with Steam's own writes (a log line). */
export function onViewerCacheGivenUp(cb: () => void): void {
    giveUp = cb;
}

/**
 * Steam rebuilds the viewer's lists from its own source now and then (when the viewer opens, or a screenshot is deleted); a
 * rebuild that lacks a screenshot only the summary found would remove ours again. Put the remembered ones back when that
 * happens: at most 5 times per 10 seconds, then never again this session (a brake: Steam and we must not fight forever).
 */
export function keepViewerCache(clients: QueryClientLike[]): void {
    for (const client of clients) {
        if (watched.has(client)) continue;
        watched.add(client);
        client.getQueryCache().subscribe((event) => {
            const key = JSON.stringify(event?.query?.queryKey);
            if (event?.type !== "updated" || (key !== JSON.stringify(ALL) && key !== JSON.stringify(LOCAL))) return;
            queueMicrotask(() => {
                try {
                    const lost = [...knownById.values()].filter((s) => inViewerCache(s, [client]) === false);
                    if (lost.length === 0) return;
                    const now = Date.now();
                    if (now - repairs.since > 10_000) {
                        repairs.n = 0;
                        repairs.since = now;
                    }
                    if (repairs.n >= 5) {
                        if (repairs.n === 5) {
                            repairs.n += 1;
                            giveUp?.();
                        }
                        return;
                    }
                    repairs.n += 1;
                    ensureInViewerCache(lost, [client]);
                } catch {
                    // The next publish writes them again.
                }
            });
        });
    }
}
