// Kernel: the shapes of the captured-activity feature (captures in every game's Activity feed), shared by its domain,
// its app use case and its surface (a surface may not import domain/). Pure.

/** The fields of a Steam screenshot this plugin reads (`SteamClient.Apps.GetScreenshotsInTimeRange`). */
export interface ScreenshotLike {
    hHandle?: number;
    nCreated: number;
    nWidth: number;
    nHeight: number;
    strCaption?: string;
    strUrl: string;
}

/** The fields of a Steam clip this plugin reads (`CGameRecordingService.GetClips`). */
export interface ClipLike {
    clip_id: string;
    date_clipped?: number;
    date_recorded?: number;
    thumbnail_url: string;
    thumbnail_width?: number;
    thumbnail_height?: number;
}

/**
 * One capture as a card in the feed. The shape is the one the activity cards read (`m_mediaItems` on the event):
 * keep the field names, the jsx patch and Steam's own card components depend on them.
 */
export interface MediaItem {
    /** Unique in Steam's workshop store: `capture_<appid>_<handle>` or `capture_<appid>_clip_<clip id>`. */
    id: string;
    url: string;
    caption: string;
    /** Unix seconds. */
    timestamp: number;
    width: number;
    height: number;
    isClip: boolean;
    rawScreenshot?: unknown;
    rawClip?: unknown;
}

/** The captures of one local day: one "captured" event in the feed. */
export interface CaptureDay {
    /** Unix seconds of the day's start (`dayOf`). */
    day: number;
    /** Newest first. */
    items: MediaItem[];
}

/** Which apps the user wants (the two settings toggles). */
export interface Scope {
    steamGames: boolean;
    nonSteamGames: boolean;
}

/** What a feed shows, as one string: same signature, nothing to write (guardrail 17.2). */
export function signature(days: readonly CaptureDay[]): string {
    return days.map((d) => `${d.day}:${d.items.map((i) => i.id).join(",")}`).join("|");
}

