// Surface `captures`: the screenshot trail. Sensors only (and the one repair the viewer already had), for a reporter who
// takes a screenshot in a shortcut, clicks its thumbnail in the Post-Game Summary, deletes it, and sees errors on the way.
//
// One line per step and screenshot, under [captures], so the log reads as the steps the reporter took:
//   trail 1/4 taken     Steam said "written" for a shortcut; 2 s later: in Steam's summary store, drawn, in the viewer
//                       cache, served, known to Steam by handle;
//   trail 2/4 click     a click on a capture image INSIDE the Post-Game Summary (no other click is looked at);
//   trail 3/4 viewer    the window Steam opened for it (on desktop a separate Media window, `steam://open/media`): found
//                       or not, what its viewer shows (shown, error, loading) and, on an error, the cause Steam's code
//                       allows (trail-core.ts viewerErrorCause), plus whether a repair brought the image back;
//   trail 4/4 deleted   Steam said "deleted", or the file vanished from Steam's image server (deleted on disk); 2 s
//                       later: still in the summary store, still drawn, still in the viewer cache, still known by handle.
// Lines carry booleans, counts, states and a per-session ordinal ("shot=#2"), never a path, a name, a handle or an id.
import { toGameId, toShortcutId } from "../../kernel/appid";
import { captureEvents, steamKnowsScreenshot, steamPopupDocuments, steamViewerListHas } from "../../steam/captures";
import { steamQueryClients } from "../../steam/query-client";
import { spotlightStore, type SteamScreenshot } from "../../steam/stores";
import { deps } from "./deps";
import { captureKind } from "./media-kinds";
import { watchDocument } from "./media-sensor";
import { isViewing } from "./viewing";
import { SUMMARY_SELECTOR, drawnInSummary, fileName, viewerErrorCause, viewerSettled, viewerState, yesNo, type ViewerState } from "./trail-core";
import { ensureInViewerCache, inViewerCache, knownScreenshot, rememberScreenshots } from "./viewer-cache";

const MAX_LINES = 60;
const CHECK_AFTER_MS = 2000;
const VIEWER_WATCH_MS = 10_000;
const VIEWER_POLL_MS = 250;
/** How long a screenshot taken or clicked this session is watched for a deletion on disk, and how often. */
const DISK_WATCH_MS = 20 * 60_000;
const DISK_POLL_MS = 10_000;
const MAX_TRACKED = 8;

interface Tracked {
    n: number;
    appid: number;
    gameid: string;
    shot: SteamScreenshot;
    since: number;
    deleted: boolean;
}

/** Screenshots this trail follows, by `<gameid>_<handle>`. */
const tracked = new Map<string, Tracked>();
const told = new Set<string>();
let lines = 0;
let ordinal = 0;
let diskTimer: ReturnType<typeof setInterval> | undefined;

function say(key: string, message: string): void {
    if (told.has(key) || lines >= MAX_LINES) return;
    told.add(key);
    lines += 1;
    deps.log(message);
}

const keyOf = (gameid: string, handle: number) => `${gameid}_${Number(handle)}`;
const label = (t: Tracked | undefined) => (t ? `shot=#${t.n}` : "shot=untracked");

function track(appid: number, shot: SteamScreenshot): Tracked {
    const gameid = String(shot.strGameID || toGameId(toShortcutId(appid)!));
    const key = keyOf(gameid, shot.hHandle);
    const known = tracked.get(key);
    if (known) return known;
    if (tracked.size >= MAX_TRACKED) tracked.delete(tracked.keys().next().value as string);
    const t: Tracked = { n: ++ordinal, appid, gameid, shot, since: Date.now(), deleted: false };
    tracked.set(key, t);
    startDiskWatch();
    return t;
}

/** Every document the summary or the viewer can be in. */
function documents(): Document[] {
    const docs = steamPopupDocuments();
    if (typeof document !== "undefined" && !docs.includes(document)) docs.push(document);
    return docs;
}

/** Steam's own summary store for this app: does its session hold the screenshot, and is the summary shown at all? */
function summaryStore(appid: number, handle: number): { inStore: boolean | undefined; events: number; gate: boolean } {
    try {
        const data = spotlightStore()?.GetOrCreateAppData(appid) as any;
        const events: any[] = data?.m_session?.GetSessionEvents?.() ?? data?.m_session?.m_rgSessionEvents ?? [];
        const inStore = events.some((e: any) => e?.m_screenshot && Number(e.m_screenshot.hHandle) === Number(handle));
        return { inStore, events: events.length, gate: !!data?.m_postGameSummary };
    } catch {
        return { inStore: undefined, events: 0, gate: false };
    }
}

function drawnAnywhere(url: string): boolean {
    return documents().some((d) => drawnInSummary(d, url));
}

async function httpStatus(url: string): Promise<string> {
    if (!url) return "none";
    const status = await deps.probeStatus(url).catch(() => undefined);
    return status === undefined ? "none" : String(status);
}

/** The checks that follow "taken" and "deleted": where Steam and the page have (or still have) the screenshot. */
async function whereItIs(t: Tracked): Promise<string> {
    const store = summaryStore(t.appid, t.shot.hHandle);
    const [byHandle, http] = await Promise.all([steamKnowsScreenshot(t.gameid, t.shot.hHandle), httpStatus(t.shot.strUrl)]);
    return (
        `in_summary_store=${yesNo(store.inStore)} summary_events=${store.events} summary_shown=${store.gate} page_open=${isViewing(t.appid)} ` +
        `drawn=${drawnAnywhere(t.shot.strUrl)} in_viewer_cache=${yesNo(inViewerCache(t.shot, steamQueryClients()))} ` +
        `steam_by_handle=${yesNo(byHandle)} file_http=${http}`
    );
}

// ---------------------------------------------------------------------------
// Step 1 and 4: Steam's screenshot notifications
// ---------------------------------------------------------------------------

function onWritten(appid: number, details: SteamScreenshot | undefined, handle: number | undefined): void {
    if (!details || !Number(details.hHandle)) {
        say(`taken|nodetails|${handle}`, `trail 1/4 taken: Steam said "written" without the screenshot's details (details=no handle=${Number(handle) > 0})`);
        return;
    }
    const t = track(appid, details);
    rememberScreenshots([details]);
    setTimeout(() => {
        void whereItIs(t).then((where) =>
            say(`taken|${t.n}`, `trail 1/4 taken: ${label(t)} notification=written kind=${captureKind(details.strUrl) ?? "none"} ${where}`),
        );
    }, CHECK_AFTER_MS);
}

function reportDeleted(t: Tracked | undefined, via: "steam" | "disk", appid: number): void {
    if (t) t.deleted = true;
    setTimeout(() => {
        const viewers = documents().map((d) => viewerState(d)).filter((s) => s !== "none");
        const tail = viewers.length ? ` viewer_now=${viewers.join(",")}` : "";
        if (!t) {
            say(`deleted|untracked|${appid}|${via}`, `trail 4/4 deleted: shot=untracked via=${via} page_open=${isViewing(appid)}${tail}`);
            return;
        }
        void whereItIs(t).then((where) => say(`deleted|${t.n}`, `trail 4/4 deleted: ${label(t)} via=${via} ${where}${tail}`));
    }, CHECK_AFTER_MS);
}

/** Steam's "written" / "deleted" for a shortcut. Registered once at install; never throws into Steam's dispatch. */
function listen(): void {
    captureEvents.onScreenshot((n) => {
        try {
            const appid = toShortcutId(n?.unAppID);
            if (appid === undefined) return;
            if (n.strOperation === "written") onWritten(appid, n.details, n.hScreenshot);
            else if (n.strOperation === "deleted") {
                const handle = Number(n.hScreenshot);
                const t = tracked.get(keyOf(toGameId(appid), handle)) ?? [...tracked.values()].find((x) => x.appid === appid && Number(x.shot.hHandle) === handle);
                reportDeleted(t, "steam", appid);
            }
        } catch {
            // A sensor never breaks Steam's notification dispatch.
        }
    });
}

/** A file deleted on disk sends no notification: Steam's image server answering 404/410 is the sign. */
function startDiskWatch(): void {
    if (diskTimer) return;
    diskTimer = setInterval(() => {
        const now = Date.now();
        const live = [...tracked.values()].filter((t) => !t.deleted && now - t.since < DISK_WATCH_MS);
        if (live.length === 0) {
            clearInterval(diskTimer);
            diskTimer = undefined;
            return;
        }
        for (const t of live) {
            void deps.probeStatus(t.shot.strUrl).then((status) => {
                if ((status === 404 || status === 410) && !t.deleted) reportDeleted(t, "disk", t.appid);
            });
        }
    }, DISK_POLL_MS);
}

// ---------------------------------------------------------------------------
// Step 2 and 3: a click in the Post-Game Summary, and the viewer it opens
// ---------------------------------------------------------------------------

function onSummaryClick(ev: Event, doc: Document): void {
    const target = ev.target as HTMLElement | null;
    const box = target?.closest?.(SUMMARY_SELECTOR);
    if (!box) return; // Only our Post-Game Summary: every other click on the page is not looked at.
    const img = (target?.closest?.("img, video") ?? box.querySelector?.("img")) as HTMLImageElement | null;
    const url = (img as any)?.currentSrc || (img as any)?.src || "";
    const kind = captureKind(url);
    if (!kind) {
        // A click on the summary but not on a capture image (an achievement, a clip panel, the pager).
        return;
    }
    const shot = knownScreenshot(url) ?? [...tracked.values()].find((t) => fileName(t.shot.strUrl) === fileName(url))?.shot;
    const t = shot ? [...tracked.values()].find((x) => x.shot === shot) ?? (toShortcutId(shot.nAppID) !== undefined ? track(toShortcutId(shot.nAppID)!, shot) : undefined) : undefined;
    const loaded = img?.complete === true && (img?.naturalWidth ?? 0) > 0;
    const clients = steamQueryClients();
    const before = shot ? inViewerCache(shot, clients) : undefined;
    let repaired = false;
    if (shot && before === false) {
        // Capture phase, before Steam's handler opens the viewer: the viewer reads its cache when it opens.
        try {
            repaired = ensureInViewerCache([shot], clients).added > 0;
        } catch {
            // Said below: repaired_before_open=false.
        }
    }
    say(
        `click|${t?.n ?? url}`,
        `trail 2/4 click: ${label(t)} in_post_game_summary=true kind=${kind} image_loaded=${loaded} known_to_summary=${shot !== undefined} ` +
            `in_viewer_cache=${yesNo(before)} repaired_before_open=${repaired}`,
    );
    followViewer(doc, shot, t);
}

/** Find the window Steam opened for the click, attach the sensors to it, and report what its viewer shows. */
function followViewer(clickDoc: Document, shot: SteamScreenshot | undefined, t: Tracked | undefined): void {
    const before = new Set(documents());
    const started = Date.now();
    const listed = shot ? steamViewerListHas(String(shot.strGameID), shot.hHandle) : Promise.resolve({ listed: undefined, total: 0 });
    let seen: Document | undefined;
    let last: ViewerState = "none";
    let healed: boolean | undefined;

    const finish = async (state: ViewerState, timedOut: boolean) => {
        const { listed: steamListed, total } = await listed;
        const cache = shot ? inViewerCache(shot, steamQueryClients()) : undefined;
        const where = seen ? (before.has(seen) ? (seen === clickDoc ? "same-window" : "existing-window") : "new-window") : "not-found";
        let line =
            `trail 3/4 viewer: ${label(t)} window=${where} after_ms=${Date.now() - started} state=${state}${timedOut ? " (still at 10 s)" : ""} ` +
            `in_viewer_cache=${yesNo(cache)} in_steam_list=${yesNo(steamListed)} steam_list_total=${total}`;
        if (state === "error") line += ` cause=${viewerErrorCause({ imageBroken: false, inViewerCache: cache, steamListed })}`;
        if (state === "image-broken") line += ` cause=${viewerErrorCause({ imageBroken: true, inViewerCache: cache, steamListed })}`;
        if (healed !== undefined) line += ` repaired_on_error=${healed}`;
        say(`viewer|${t?.n ?? started}`, line);

        // An error for a screenshot missing from the cache: put it there once and say whether the viewer came back.
        if (state === "error" && shot && seen && healed === undefined) {
            try {
                healed = ensureInViewerCache([shot], steamQueryClients()).added > 0;
            } catch {
                healed = false;
            }
            const doc = seen;
            setTimeout(() => {
                say(`heal|${t?.n ?? started}`, `trail 3/4 viewer after repair: ${label(t)} added=${healed} state=${viewerState(doc)}`);
            }, 1500);
        }
    };

    const timer = setInterval(() => {
        try {
            if (!seen) {
                // The viewer's own markup marks its window; a new window is preferred over the one clicked in.
                const docs = documents();
                seen = docs.find((d) => !before.has(d) && viewerState(d) !== "none") ?? docs.find((d) => viewerState(d) !== "none");
                if (seen) watchDocument(seen);
            }
            const state = seen ? viewerState(seen) : "none";
            last = state;
            const elapsed = Date.now() - started;
            if (viewerSettled(state) || elapsed >= VIEWER_WATCH_MS) {
                clearInterval(timer);
                void finish(state, !viewerSettled(state));
            }
        } catch {
            clearInterval(timer);
            void finish(last, false);
        }
    }, VIEWER_POLL_MS);
}

const clickWatched = new WeakSet<Document>();

/** Watch clicks in every Steam window reachable now (each page view calls this again; a document is attached once). */
export function attachTrailClicks(): void {
    for (const doc of documents()) {
        if (clickWatched.has(doc)) continue;
        clickWatched.add(doc);
        try {
            doc.addEventListener("click", (ev) => {
                try {
                    onSummaryClick(ev, doc);
                } catch {
                    // A sensor never breaks a click.
                }
            }, true);
        } catch {
            // A document we cannot attach to is skipped.
        }
    }
}

let installed = false;

/** Install the notification listener once (the captures kill switch owns it). */
export function installTrail(): void {
    if (installed) return;
    installed = true;
    listen();
    attachTrailClicks();
}
