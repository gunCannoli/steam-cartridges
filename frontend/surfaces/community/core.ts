/**
 * Pure part of the community surface (features plan F2, ADR-0046): our media items as the items Steam's Community
 * Content loader returns from `library/appcommunityfeed/<appid>` (module 77163, class `ae`). Shape copied from a live
 * feed (435150, 2026-09-30): the card code reads every field below. Its one runtime import carries `.ts` for the tests.
 *
 * Card types Steam renders (EWorkshopFileType, module 44846): 3 Artwork and 5 Screenshot (an image; a click opens
 * Steam's fullscreen viewer on full_image_url), 4 Video (Steam's own YouTube player on youtube_video_id). Guides (9, 10)
 * open a Community page by file id, so no item becomes one.
 */
import type { MediaItem } from "../../kernel/record";
import type { MediaImage } from "../../kernel/media-bin";
import { toShortcutId } from "../../kernel/appid.ts";
import { EPIC_ICON, IGDB_ICON, SCREENSCRAPER_ICON, XBOX_ICON } from "./icons.ts";

export const FILE_TYPE = { artwork: 3, video: 4, screenshot: 5 } as const;

/**
 * Our cards' published file ids: 15 digits from 9e14 (Valve's ids are ~3.8e9 today), unique per (shortcut, index),
 * and a safe integer. Steam keys cards, dedupes pages and asks PublishedFile.GetDetails by this id.
 */
export const FEED_ID_BASE = 900_000_000_000_000;
export const MAX_ITEMS = 10_000;

export function feedId(appid: number, index: number): string {
    return String(FEED_ID_BASE + appid * MAX_ITEMS + index);
}

export const CREATOR_NAMES: Record<MediaItem["source"], string> = { igdb: "IGDB", screenscraper: "ScreenScraper", epic: "Epic Games Store", xbox: "Xbox" };

/**
 * Each source is a made-up Steam account (public individual accounts 2147483101 to 2147483104, at the top of the signed
 * int32 range), so `new SteamID(...)` is valid and Steam's own author and "Created by" components accept it. They must
 * stay below 2^31: Steam converts an account id with signed bit operations when it opens a comment thread, and a
 * protobuf uint32 writer then asserts on the negative value (verified live 2026-09-30, guardrail 1). The 64-bit ids are
 * decimal strings because they exceed 2^53.
 */
export const CREATOR_STEAMIDS: Record<MediaItem["source"], string> = {
    igdb: "76561200107748829",
    screenscraper: "76561200107748830",
    epic: "76561200107748831",
    xbox: "76561200107748832",
};
const ACCOUNT_SOURCE: Record<number, MediaItem["source"]> = { 2147483101: "igdb", 2147483102: "screenscraper", 2147483103: "epic", 2147483104: "xbox" };

/** The source whose made-up account this is, or undefined for any real account. O(1). */
export function sourceOfAccount(accountId: unknown): MediaItem["source"] | undefined {
    return typeof accountId === "number" ? ACCOUNT_SOURCE[accountId] : undefined;
}

/** A card's author icon: each source's own logo, inline (icons.ts), instead of Steam's "?" avatar. */
export const CREATOR_AVATARS: Record<MediaItem["source"], string> = {
    igdb: IGDB_ICON,
    screenscraper: SCREENSCRAPER_ICON,
    epic: EPIC_ICON,
    xbox: XBOX_ICON,
};

/** One item of Steam's community feed, as its card components read it. */
export interface FeedItem {
    published_file_id: string;
    type: number;
    title: string;
    description: string;
    preview_image_url: string;
    full_image_url: string;
    image_width: number;
    image_height: number;
    youtube_video_id: string | null;
    /** null hides the count (Steam renders a count only when it is not null). */
    comment_count: null;
    votes_for: null;
    /** Must be an array: the card filters the user's content preferences with indexOf on it. */
    content_descriptorids: number[];
    spoiler_tag: boolean;
    rating_stars: number;
    maybe_inappropriate_sex: number;
    maybe_inappropriate_violence: number;
    creator: { name: string; steamid: string; avatar: string; online_state: number };
    reactions: never[];
}

const youtubeThumb = (id: string) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

const MANUAL_COVER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a475e"/><stop offset="1" stop-color="#171a21"/></linearGradient></defs>' +
    '<rect width="1280" height="720" fill="url(#g)"/>' +
    '<g fill="none" stroke="#c7d5e0" stroke-width="14" stroke-linejoin="round">' +
    '<path d="M640 250 C580 215 500 205 430 215 V455 C500 445 580 455 640 490 C700 455 780 445 850 455 V215 C780 205 700 215 640 250 Z"/>' +
    '<path d="M640 250 V490"/></g>' +
    '<text x="640" y="590" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="700" letter-spacing="8" fill="#c7d5e0">MANUAL</text>' +
    "</svg>";

/**
 * The size the manual card reports to Steam, whatever the cover image is. Steam picks a card's cell from these numbers
 * (module 77163, `pe()`): 16:9 is the "wide" aspect (32), and a width of 513 to 1023 is the small width (2), giving cell
 * class 34, the ordinary small cell of IGDB screenshots. 1280 wide (class 36, the large width) is a tall cell that Steam's
 * row layout dropped as the first card (live 2026-10-01).
 */
export const MANUAL_CARD_WIDTH = 960;
export const MANUAL_CARD_HEIGHT = 540;

/** The manual card's placeholder cover (features plan F2c): inline, so showing it makes no request; 16:9. */
export const MANUAL_COVER = `data:image/svg+xml;utf8,${encodeURIComponent(MANUAL_COVER_SVG)}`;
const MANUAL_MARK = "#manual-";

/**
 * The cover URL of one shortcut's manual: the same image, told apart by a fragment, because the image viewer is matched to
 * its card by this URL (viewerMeta) and each shortcut's manual must open its own pages.
 */
export function manualCoverUrl(appid: number, key: string): string {
    return `${MANUAL_COVER}${MANUAL_MARK}${appid}-${encodeURIComponent(key)}`;
}

/** The manual a cover URL names, or undefined for any other URL. O(1) for a URL that is not a cover. */
export function manualOfUrl(url: unknown): { appid: number; key: string } | undefined {
    if (typeof url !== "string" || !url.startsWith(MANUAL_COVER)) return undefined;
    const match = /^(\d+)-(.+)$/.exec(url.slice(MANUAL_COVER.length + MANUAL_MARK.length));
    if (!match || url.slice(MANUAL_COVER.length, MANUAL_COVER.length + MANUAL_MARK.length) !== MANUAL_MARK) return undefined;
    return { appid: Number(match[1]), key: decodeURIComponent(match[2]!) };
}

/**
 * The feed for one shortcut, in the record's order. A ScreenScraper item shows only when `imageOf(key)` has its
 * object URL (app/media fetched it); an item that cannot be shown is left out. A manual shows its first page
 * (`coverOf(key)`, app/manuals) and the placeholder cover until that is rendered.
 */
/** The caption of a card whose item has none (IGDB images, items cached before captions existed). */
const DEFAULT_TITLES: Record<MediaItem["kind"], string> = { video: "Video", screenshot: "Screenshot", artwork: "Artwork", manual: "Manual" };

export function toFeedItems(
    appid: number,
    items: readonly MediaItem[],
    imageOf: (key: string) => MediaImage | undefined,
    coverOf: (key: string) => string | undefined = () => undefined,
): FeedItem[] {
    const out: FeedItem[] = [];
    items.forEach((item, index) => {
        if (index >= MAX_ITEMS) return;
        let type: number;
        let preview: string;
        let full: string;
        let width = 0;
        let height = 0;
        let youtube: string | null = null;
        if (item.kind === "manual") {
            if (!item.key) return;
            type = FILE_TYPE.artwork;
            preview = full = coverOf(item.key) ?? manualCoverUrl(appid, item.key);
            width = MANUAL_CARD_WIDTH;
            height = MANUAL_CARD_HEIGHT;
        } else if (item.kind === "video") {
            if (!item.youtube) return;
            type = FILE_TYPE.video;
            youtube = item.youtube;
            preview = full = youtubeThumb(item.youtube);
        } else if (item.kind === "screenshot" || item.kind === "artwork") {
            type = FILE_TYPE[item.kind];
            if (item.source === "screenscraper") {
                const image = item.key ? imageOf(item.key) : undefined;
                if (!image) return;
                preview = full = image.url;
                width = image.width ?? item.width ?? 0;
                height = image.height ?? item.height ?? 0;
            } else {
                if (!item.url) return;
                full = item.url;
                preview = item.thumb ?? item.url;
                width = item.width ?? 0;
                height = item.height ?? 0;
            }
            // Steam lays an image out by its size and drops one without it (no row template matches size 0).
            if (!(width > 0 && height > 0)) return;
        } else {
            return;
        }
        out.push({
            published_file_id: feedId(appid, index),
            type,
            title: item.title || DEFAULT_TITLES[item.kind],
            description: "",
            preview_image_url: preview,
            full_image_url: full,
            image_width: width,
            image_height: height,
            youtube_video_id: youtube,
            comment_count: null,
            votes_for: null,
            content_descriptorids: [],
            spoiler_tag: false,
            rating_stars: 0,
            maybe_inappropriate_sex: 0,
            maybe_inappropriate_violence: 0,
            creator: { name: CREATOR_NAMES[item.source] ?? "", steamid: CREATOR_STEAMIDS[item.source] ?? "0", avatar: CREATOR_AVATARS[item.source] ?? "", online_state: 0 },
            reactions: [],
        });
    });
    return out;
}

/** A fresh copy for each load: Steam's cards write into what they are given (votes), and desktop and Big Picture load separately. */
export function copyFeed(feed: readonly FeedItem[]): FeedItem[] {
    return feed.map((item) => ({ ...item, content_descriptorids: [], reactions: [], creator: { ...item.creator } }));
}

/**
 * What the patched `LoadCommunityContentAndVotes(appid, page)` returns for one of our shortcuts, or undefined to let
 * Steam's own loader run (a native app, a mapped shortcut whose appid native-links already swapped, or no feed).
 * Page 1 is the whole feed; later pages are empty, so Steam shows its own "no more content" line.
 */
export function loaderAnswer(
    rawAppid: unknown,
    page: unknown,
    feedOf: (appid: number) => readonly FeedItem[] | undefined,
): { vecContent: FeedItem[]; mapVotes: Map<string, unknown> } | undefined {
    const appid = toShortcutId(rawAppid);
    if (appid === undefined) return undefined;
    const feed = feedOf(appid);
    if (!feed || feed.length === 0) return undefined;
    return { vecContent: Number(page) <= 1 ? copyFeed(feed) : [], mapVotes: new Map() };
}

/** Is this jsx element Steam's Community Content section class (the one that owns the loader)? O(1). */
export function isContentSection(type: unknown, props: unknown): boolean {
    if (typeof type !== "function") return false;
    const p = props as { appid?: unknown; labelId?: unknown } | null | undefined;
    if (!p || typeof p.appid !== "number" || !("labelId" in p)) return false;
    const proto = (type as { prototype?: object }).prototype;
    return !!proto && "BindInnerContainer" in proto && "AutoLoadAdditionalContent" in proto && "CheckAndLoadInitialContent" in proto;
}

/**
 * Should the section's loader fetch its first page now? Steam loads it from two signals: a 1 s timer that needs
 * `m_bOnScreen` already true, or an IntersectionObserver change from false to true. When the observer's first callback
 * comes after the timer (a busy page open), neither fires and the section stays empty until it is remounted (seen live,
 * 2026-09-30). For a shortcut with a feed, loading needs no network, so we load it as soon as the loader is bound or
 * resized. Only while nothing has been requested yet (`m_nNextPage` 1) and Steam has built its placeholder rows (they
 * are not built when the user disabled community content), so Steam's own paging and setting still apply.
 */
export function shouldLoadFirstPage(
    loader: { m_nNextPage?: unknown; m_bHasEmptyRows?: unknown; m_unAppID?: unknown } | null | undefined,
    hasFeed: (appid: number) => boolean,
): boolean {
    if (!loader || loader.m_nNextPage !== 1 || loader.m_bHasEmptyRows !== true) return false;
    const appid = toShortcutId(loader.m_unAppID);
    return appid !== undefined && hasFeed(appid);
}

/** A page-1 answer with no cards: Steam shows its own "no more content" line. */
export const EMPTY_ANSWER = (): { vecContent: FeedItem[]; mapVotes: Map<string, unknown> } => ({ vecContent: [], mapVotes: new Map() });

/** How long a feed whose manual has no first-page cover yet waits for it before it is served with the placeholder (ms). */
export const COVER_WAIT_MS = 8_000;

/** How long a shortcut's first page waits for its media before Steam is told there is nothing (ms). */
export const FIRST_PAGE_HOLD_MS = 120_000;

export interface FirstPageHold {
    /** A promise Steam's loader awaits: its answer once `release(appid)` runs, or after the time limit. */
    hold(appid: number): Promise<unknown>;
    /** The shortcut's feed is ready, or no feed will come: answer everything held for it. */
    release(appid: number): void;
    releaseAll(): void;
}

/**
 * Steam keeps its placeholder rows (and their loading animation) while the loader's call is pending. For a shortcut whose
 * media is still being fetched the first page is held instead of answered empty, so the section shows Steam's own loading
 * state and then the real cards. `answerFor` builds the answer at release time (the feed, else an empty page).
 */
export function createFirstPageHold(
    answerFor: (appid: number) => unknown,
    ms: number = FIRST_PAGE_HOLD_MS,
    timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void } = {
        set: (fn, delay) => setTimeout(fn, delay),
        clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
): FirstPageHold {
    const held = new Map<number, Array<() => void>>();
    const release = (appid: number): void => {
        const waiting = held.get(appid);
        held.delete(appid);
        waiting?.forEach((done) => done());
    };
    return {
        hold(appid) {
            return new Promise((resolve) => {
                let timer: unknown;
                const done = () => {
                    timers.clear(timer);
                    resolve(answerFor(appid));
                };
                timer = timers.set(done, ms);
                const list = held.get(appid) ?? [];
                list.push(done);
                held.set(appid, list);
            });
        },
        release,
        releaseAll() {
            for (const appid of [...held.keys()]) release(appid);
        },
    };
}

/** Is this a published file id of ours (15 digits from FEED_ID_BASE)? O(1). */
export function isOurFeedId(id: unknown): boolean {
    return typeof id === "string" && id.length === 15 && Number(id) >= FEED_ID_BASE;
}

/** What to do with one jsx element of Steam's Community Content cards. */
export type CardElement = "hide" | "strip-menu" | "strip-click";

/**
 * Steam's card renders vote, award and comment buttons (`showVotingControls` + comments) and a Report menu for every card,
 * and they act on Valve's servers with the card's file id, which for ours Valve does not know. So for our cards those
 * components render nothing, and the card's gamepad options menu (Report only) is removed. Any other element: undefined.
 */
export function cardElement(props: unknown): CardElement | undefined {
    const p = props as Record<string, any> | null | undefined;
    if (!p || typeof p !== "object") return undefined;
    const card = p.card;
    if (card !== undefined) {
        if (!isOurFeedId(card?.item?.published_file_id)) return undefined;
        if ("showVotingControls" in p) return "hide"; // the award, thumbs and comments row
        if ("onReported" in p) return "hide"; // the Report menu button
        return undefined;
    }
    if (typeof p.onMenuButton === "function" && isOurFeedId(p["data-id"])) return "strip-menu";
    // The author row's avatar opens `SteamIDPage(creator.steamid)`: a made-up account on ours (D9 of the release plan).
    // Our avatars are inline icons no real account has, so the URL alone tells the card is ours.
    if (typeof p.onClick === "function" && isOurAvatar(p.strAvatarURL)) return "strip-click";
    return undefined;
}

const OUR_AVATARS = new Set<string>(Object.values(CREATOR_AVATARS));

/** Is this one of our made-up accounts' inline avatars? O(1). */
export function isOurAvatar(url: unknown): boolean {
    return typeof url === "string" && OUR_AVATARS.has(url);
}

/**
 * The viewer's date row shows the game's icon (`AppIcon`) from app info. A non-Steam file has no appid, so Steam falls back
 * to its default avatar (`avatars.steamstatic.com`, never an app icon's host) and the image draws a broken mark (verified
 * live 2026-09-30). Such an image, or one with no `src`, is rendered as an empty span instead. O(1).
 */
export function isPlaceholderAppIcon(type: unknown, props: unknown): boolean {
    if (type !== "img") return false;
    const p = props as { src?: unknown; className?: unknown } | null | undefined;
    if (!p || typeof p.className !== "string" || !p.className.includes("AppIcon")) return false;
    return p.src === undefined || (typeof p.src === "string" && p.src.includes("avatars.steamstatic.com/"));
}

/**
 * Our image viewer's layout (Big Picture, verified live 2026-09-30): the image is capped at 600 px, which on a shorter
 * window pushes the Close button under Steam's footer bar. The cap follows the window instead: the 330 px is the space the
 * details row, the Close button, the header and Steam's footer need.
 */
export const VIEWER_IMAGE_MAX_HEIGHT = "max(260px, min(600px, calc(100vh - 330px)))";

/** Is this `img` the viewer's big image of one of ours, still carrying Steam's own pixel cap? O(1). */
export function isViewerImage(type: unknown, props: unknown, isOurUrl: (url: string) => boolean): boolean {
    if (type !== "img") return false;
    const p = props as { src?: unknown; style?: { maxHeight?: unknown } } | null | undefined;
    if (!p || typeof p.src !== "string" || typeof p.style?.maxHeight !== "string") return false;
    return p.style.maxHeight.endsWith("px") && isOurUrl(p.src);
}

/** The viewer's date and game-icon row. The date is when we fetched the media, not when it was made, so it is dropped. O(1). */
export function isDateRow(type: unknown, props: unknown): boolean {
    if (type !== "div") return false;
    const p = props as { className?: unknown } | null | undefined;
    return !!p && typeof p.className === "string" && p.className.includes("IconAndDate");
}

/**
 * The viewer's "Scroll down for comments" line (the `ArtworkModal_ScrollForMore` token; English text only). Steam draws it
 * only when the viewer has children, and ours has them only for a manual. O(1) for any element but that line.
 */
export function isScrollLabel(type: unknown, props: unknown): boolean {
    if (type !== "div") return false;
    const p = props as { className?: unknown; children?: unknown } | null | undefined;
    return (
        !!p &&
        typeof p.className === "string" &&
        p.className.includes("ScrollForMore") &&
        Array.isArray(p.children) &&
        p.children.some((child) => typeof child === "string" && /^scroll down for comments$/i.test(child.trim()))
    );
}

/** The line that replaces it. */
export const MANUAL_SCROLL_TEXT = "Scroll down to view the manual";

/** The viewer's "Created by" label (English text only; another language keeps Steam's own word). O(1). */
export function isCreatedByLabel(type: unknown, props: unknown): boolean {
    if (type !== "div") return false;
    const p = props as { className?: unknown; children?: unknown } | null | undefined;
    return !!p && typeof p.children === "string" && typeof p.className === "string" && p.className.includes("Label") && /^created by$/i.test(p.children.trim());
}

/**
 * Steam reuses the Community Content section for the next app and only resets its placeholder rows: the loader keeps the
 * previous app's id, page counter, cards and "out of content" state (seen live 2026-09-30: a section for one game holding
 * another game's 17 cards, never loading its own). True when the section now shows `appid` but its loader is still the
 * previous one's: the section must get a fresh loader.
 */
export function loaderIsStale(
    section: { props?: { appid?: unknown } } | null | undefined,
    previousAppid: unknown,
    loader: { m_unAppID?: unknown } | null | undefined,
): boolean {
    const appid = section?.props?.appid;
    if (typeof appid !== "number" || !loader || previousAppid === appid) return false;
    return loader.m_unAppID !== appid;
}
