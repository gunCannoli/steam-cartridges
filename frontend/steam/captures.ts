// Steam bindings of the captured-activity feature (captures in every game's Activity feed; ported from the
// steam-captured-activity plugin 2026-11-12): screenshots and clips Steam keeps, its workshop store, its capture events.
import { resolveService, resolveSingleton } from "./modules";
import type { SteamClip, SteamScreenshot } from "./stores";

/** One published file record in Steam's workshop store. */
export interface PublishedFileRecord {
    publishedfileid: string;
    file_url: string;
    preview_url: string;
    file_description: string;
    visibility: number;
    creator: string;
    time_created?: number;
    image_width?: number;
    image_height?: number;
}

/** Steam's `CWorkshopStore` singleton. */
export interface WorkshopStore {
    m_mapPublishedFiles: Map<string, { file?: PublishedFileRecord }>;
}

/** A service notification as Steam hands it to a handler; the handler answers an EResult (1 = OK). */
export interface RecordingNotification {
    Body(): { toObject(): Record<string, any> };
}
type NotificationHandler = (msg: RecordingNotification) => number;

/** Steam's game-recording CM service. */
interface CaptureRecordingService {
    GetClips(request: { game_id: string; created_after: number }): Promise<{
        Body(): { clip(): Array<{ toObject(): SteamClip }> | undefined };
    }>;
    /** `GameRecording.NotifyClipCreated#1`: `{ summary: <a clip, as GetClips lists it> }`. */
    RegisterForNotifyClipCreated?(handler: NotificationHandler): { unregister(): void } | null;
    /** `GameRecording.NotifyClipDeleted#1`: `{ clip_id, game_id }` (CGameRecording_ClipDeleted_Notification). */
    RegisterForNotifyClipDeleted?(handler: NotificationHandler): { unregister(): void } | null;
}

/** One day's worth of activity feed events. */

function gameRecordingService(): CaptureRecordingService | undefined {
    return resolveService<CaptureRecordingService>("CCaptureRecordingService", ["GetClips", "GetAndTrimPostGameHighlights"]);
}

export function workshopStore(): WorkshopStore | undefined {
    const globalWs = Reflect.get(globalThis, "workshopStore") as WorkshopStore | undefined;
    if (globalWs) return globalWs;
    return resolveSingleton<WorkshopStore>("CWorkshopStore", ["GetPublishedFiles"]);
}

/** `GetScreenshotsInTimeRange` returns at most this many, the newest first (measured live 2026-10-07: 100 of 152). */
const SCREENSHOT_PAGE = 100;
/** Pages read per app at most, so a sweep stays bounded (2,000 screenshots). */
const MAX_SCREENSHOT_PAGES = 20;

/**
 * Screenshots Steam indexed for this app, keyed by the 32-bit appid for Steam games and shortcuts alike, with
 * loopback URLs Steam serves itself. A deleted screenshot is gone from this list (Steam's own index). Steam answers
 * a page of the newest SCREENSHOT_PAGE; the next page is the range ending just before the oldest one.
 */
export async function screenshotsOf(appid: number): Promise<SteamScreenshot[]> {
    const apps = (Reflect.get(globalThis, "SteamClient") as unknown as { Apps?: Record<string, unknown> } | undefined)?.Apps;
    const fn = apps?.GetScreenshotsInTimeRange as ((appid: number, start: number, end: number) => Promise<SteamScreenshot[]>) | undefined;
    if (typeof fn !== "function") return [];
    const all: SteamScreenshot[] = [];
    try {
        let end = 0; // 0: no upper bound
        for (let page = 0; page < MAX_SCREENSHOT_PAGES; page++) {
            const list = (await fn.call(apps, appid, 0, end)) ?? [];
            all.push(...list);
            if (list.length < SCREENSHOT_PAGE) break;
            const oldest = Math.min(...list.map((s) => s.nCreated));
            if (!(oldest > 1)) break;
            end = oldest - 1;
        }
    } catch {
        /* what was read so far */
    }
    return all;
}

/**
 * Clips Steam recorded for this game. Takes the clip game id (kernel/appid clipGameId): Steam's own helper truncates
 * a shortcut's 64-bit gameid, which is why its feed finds no clips for non-Steam games.
 */
export async function clipsOf(gameid: string): Promise<SteamClip[]> {
    const service = gameRecordingService();
    if (!service) return [];
    try {
        const response = await service.GetClips({ game_id: gameid, created_after: 0 });
        return (response.Body().clip() ?? []).map((c) => c.toObject());
    } catch {
        return [];
    }
}

/** What Steam says when a screenshot is taken or deleted (`SteamClient.GameSessions.RegisterForScreenshotNotification`). */
export interface ScreenshotNotification {
    strOperation: "started" | "written" | "deleted" | string;
    unAppID: number;
    hScreenshot?: number;
    /** The screenshot itself, on "written" (Steam's spotlight store pushes exactly this into the summary). */
    details?: SteamScreenshot;
}

function screenshotsApi(): Record<string, any> | undefined {
    return (Reflect.get(globalThis, "SteamClient") as any)?.Screenshots;
}

/**
 * Does Steam's own per-handle lookup still know this screenshot (`Screenshots.GetLocalScreenshotByHandle`, the call its
 * upload code uses)? `undefined` when the API is missing or failed.
 */
export async function steamKnowsScreenshot(gameid: string, handle: number): Promise<boolean | undefined> {
    const api = screenshotsApi();
    if (typeof api?.GetLocalScreenshotByHandle !== "function") return undefined;
    try {
        const s = await api.GetLocalScreenshotByHandle(gameid, handle);
        return !!s && Number(s.hHandle) === Number(handle);
    } catch {
        return false;
    }
}

/**
 * Is this screenshot in the list Steam's media viewer builds its cache from (`GetAllAppsLocalScreenshotsRange`, read in
 * pages of 1000 as Steam does)? `listed` is undefined when the API is missing or failed.
 */
export async function steamViewerListHas(gameid: string, handle: number): Promise<{ listed: boolean | undefined; total: number }> {
    const api = screenshotsApi();
    if (typeof api?.GetAllAppsLocalScreenshotsCount !== "function" || typeof api?.GetAllAppsLocalScreenshotsRange !== "function") {
        return { listed: undefined, total: 0 };
    }
    try {
        const total = Number(await api.GetAllAppsLocalScreenshotsCount()) || 0;
        for (let from = 0; from < total; from += 1000) {
            const page: SteamScreenshot[] = (await api.GetAllAppsLocalScreenshotsRange(from, Math.min(total - 1, from + 999))) ?? [];
            if (page.some((s) => String(s.strGameID) === gameid && Number(s.hHandle) === Number(handle))) return { listed: true, total };
        }
        return { listed: false, total };
    } catch {
        return { listed: undefined, total: 0 };
    }
}

/** The documents of every Steam window open now (`g_PopupManager`, which also holds the Media window). */
export function steamPopupDocuments(): Document[] {
    const docs: Document[] = [];
    try {
        const manager = (globalThis as any).g_PopupManager;
        for (const p of manager?.GetPopups?.() ?? []) {
            const doc = p?.m_popup?.document ?? p?.window?.document;
            if (doc && !docs.includes(doc)) docs.push(doc);
        }
    } catch {
        // No popup manager: the caller falls back to the windows it already knows.
    }
    try {
        for (const w of (globalThis as any).SteamUIStore?.WindowStore?.SteamUIWindows ?? []) {
            const doc = w?.BrowserWindow?.document;
            if (doc && !docs.includes(doc)) docs.push(doc);
        }
    } catch {
        // As above.
    }
    return docs;
}

/**
 * Steam's own capture events, the ones its spotlight store and media view listen to (verified 2026-10-07 in Steam's
 * source: modules 12750 and 65528 register the screenshot notification, 57622 and 2773 the clip ones; several
 * listeners are normal). Each `on*` returns an unregister function, or undefined when Steam has no such API.
 */
export const captureEvents = {
    onScreenshot(fn: (n: ScreenshotNotification) => void): (() => void) | undefined {
        const sessions = (Reflect.get(globalThis, "SteamClient") as any)?.GameSessions;
        const reg = sessions?.RegisterForScreenshotNotification;
        if (typeof reg !== "function") return undefined;
        const handle = reg.call(sessions, fn);
        return () => handle?.unregister?.();
    },
    onClipCreated(fn: (body: Record<string, any>) => void): (() => void) | undefined {
        return onClip("RegisterForNotifyClipCreated", fn);
    },
    onClipDeleted(fn: (body: Record<string, any>) => void): (() => void) | undefined {
        return onClip("RegisterForNotifyClipDeleted", fn);
    },
};

function onClip(
    name: "RegisterForNotifyClipCreated" | "RegisterForNotifyClipDeleted",
    fn: (body: Record<string, any>) => void,
): (() => void) | undefined {
    const service = gameRecordingService();
    const reg = service?.[name];
    if (typeof reg !== "function") return undefined;
    const handle = reg.call(service, (msg: RecordingNotification) => {
        try {
            fn(msg.Body().toObject());
        } catch {
            /* a listener never breaks Steam's dispatch */
        }
        return 1; // EResult OK, as Steam's own handlers answer
    });
    return handle ? () => handle.unregister() : undefined;
}
