// Surface `community` (features plan F2, ADR-0046): Steam's own Community Content section (desktop section
// `community`, Big Picture COMMUNITY tab, both `wb({ appid })` of module 77163) shows a shortcut's community media as
// Steam's own cards. Pure logic in core.ts.
//
// Steam's loader (class `ae`, not exported) fetches `library/appcommunityfeed/<appid>` in
// `LoadCommunityContentAndVotes(appid, page)`. We patch that one prototype method: for a shortcut with a feed it returns
// ours (and no vote summary call); for everything else it calls Steam's. The class is reached once: a jsx observer
// learns the section class the first time Steam renders one (core.isContentSection), a timer then builds one throwaway
// section (constructor only: no mount, no request) to read its loader's prototype, patches it and disposes the hook.
// Verified live 2026-09-30 (435150): the element type is the class, a throwaway's loader shares the mounted one's
// prototype. The first page loads >= 1 s after the section mounts, so the patch is in place before it.
import { afterPatch, callOriginal, replacePatch } from "@steambrew/client";
import { logger } from "../../logger";
import { toShortcutId, type ShortcutId } from "../../kernel/appid";
import type { EventBus } from "../../kernel/events";
import type { ManualView } from "../../kernel/manual-shelf";
import type { MediaImage } from "../../kernel/media-bin";
import type { MediaItem } from "../../kernel/record";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { keepJsxPatched, type JsxHookDiagnostics } from "../../steam/jsx-hook";
import { jsxRuntime } from "../../steam/modules";
import {
    cardElement,
    CREATOR_AVATARS,
    CREATOR_NAMES,
    CREATOR_STEAMIDS,
    isContentSection,
    isCreatedByLabel,
    loaderIsStale,
    COVER_WAIT_MS,
    createFirstPageHold,
    EMPTY_ANSWER,
    isDateRow,
    isScrollLabel,
    isPlaceholderAppIcon,
    isViewerImage,
    loaderAnswer,
    MANUAL_SCROLL_TEXT,
    manualCoverUrl,
    manualOfUrl,
    shouldLoadFirstPage,
    sourceOfAccount,
    toFeedItems,
    VIEWER_IMAGE_MAX_HEIGHT,
    type FeedItem,
} from "./core";
import { createManualPages } from "./manual";

export interface CommunityDeps extends SurfaceDeps {
    /** The object URL app/media put in the media bin for a ScreenScraper item (a pure read). */
    imageOf(appid: number, key: string): MediaImage | undefined;
    /** The pages app/manuals rendered for a manual (kernel/manual-shelf; a pure read). */
    manualOf(appid: number, key: string): ManualView | undefined;
    /** The manual's first page as a card cover (kernel/manual-shelf), once rendered. */
    coverOf(appid: number, key: string): string | undefined;
    /** Be told when the manual shelf changes. */
    onManuals(listener: () => void): () => void;
    /** To emit this surface's own result event, `community.manual-opened`. */
    bus: Pick<EventBus, "emit">;
}

/** Set by createCommunitySurface; open defaults until then. */
let deps: CommunityDeps = {
    isEnabled: () => true,
    reportError: () => {},
    imageOf: () => undefined,
    manualOf: () => undefined,
    coverOf: () => undefined,
    onManuals: () => () => {},
    bus: { emit: () => {} },
};

/** Shortcut appid -> its feed, from record.media (render). */
const feeds = new Map<number, FeedItem[]>();
let hook: ReturnType<typeof keepJsxPatched> | undefined;
let lastJsx: JsxHookDiagnostics[] = [];
let learnScheduled = false;
let unpatchLoader: (() => void) | undefined;
let firstPageLoads = 0;
let loaderRebuilds = 0;

/** What the image viewer needs to show "Created by" and a date for one of our images (by the URL the card opens). */
interface ViewerMeta {
    source: MediaItem["source"];
    seconds: number;
    /** Set for a manual's cover: the viewer shows its pages under the cover (features plan F2c). */
    manual?: { appid: number; key: string };
}
const viewerMeta = new Map<string, ViewerMeta>();
const viewerUrlsByApp = new Map<number, string[]>();
let cardsHook: ReturnType<typeof keepJsxPatched> | undefined;
let cardsHidden = 0;
/** First-page loads held while a shortcut's media is being fetched (core.createFirstPageHold). */
const firstPageHold = createFirstPageHold((appid) => loaderAnswer(appid, 1, (id) => feeds.get(id)) ?? EMPTY_ANSWER());
/** Shortcuts whose media part is final here: a feed exists, or none will (so nothing is held for them). */
const settled = new Set<number>();
/** Shortcuts whose feed waits for the manual's first-page cover: 'waiting' until it arrives or COVER_WAIT_MS passes, then 'done' (once per session). */
const coverWait = new Map<number, "waiting" | "done">();
/** The manual page column (surfaces/community/manual.ts), made once the jsx runtime is found. */
let ManualPages: ((props: { appid: number; manualKey: string }) => unknown) | undefined;
/** How many of our image viewers are open: the viewer-only tweaks (label, date, image height) apply only then. */
let openViewers = 0;
let served = 0;

interface SectionInstance {
    props?: { appid?: unknown };
    m_loader?: { m_unAppID?: unknown; CancelRequests?: () => void; OnBind?: (width: number) => void; constructor: new (appid: number) => unknown };
    m_elInnerContainer?: HTMLElement;
    m_bOnScreen?: boolean;
    forceUpdate?: () => void;
}

/**
 * The section's props changed to another app but its loader is the previous one's: build a fresh loader for the new app,
 * bind it at the container's width, and set Steam's on-screen flag from the element's real position, because Steam's own
 * `componentDidUpdate` just cleared it and its observer only reports a change (so nothing would ever load).
 */
function rebuildStaleLoader(section: SectionInstance, previousAppid: unknown): void {
    const old = section.m_loader;
    if (!old || !loaderIsStale(section, previousAppid, old)) return;
    const appid = section.props!.appid as number;
    old.CancelRequests?.();
    const fresh = new old.constructor(appid) as NonNullable<SectionInstance["m_loader"]>;
    const el = section.m_elInnerContainer;
    if (el) {
        fresh.OnBind?.(el.clientWidth); // also loads our feed at once (loadFirstPage)
        const rect = el.getBoundingClientRect();
        const height = el.ownerDocument.defaultView?.innerHeight ?? 0;
        section.m_bOnScreen = rect.bottom > 0 && rect.top < height;
    }
    section.m_loader = fresh;
    loaderRebuilds++;
    section.forceUpdate?.();
}

function patchLoader(section: new (props: unknown) => { m_loader?: object }): void {
    if (unpatchLoader) return;
    const probe = new section({ appid: 0, labelId: "" });
    const proto = probe.m_loader ? (Object.getPrototypeOf(probe.m_loader) as Record<string, unknown>) : undefined;
    if (!proto || typeof proto.LoadCommunityContentAndVotes !== "function") {
        throw new Error("Community Content loader has no LoadCommunityContentAndVotes; left stock.");
    }
    const patch = replacePatch(proto, "LoadCommunityContentAndVotes", function (args: unknown[]): unknown {
        if (!deps.isEnabled("community")) return callOriginal;
        try {
            const answer = loaderAnswer(args[0], args[1], (appid) => feeds.get(appid));
            if (!answer) {
                // A shortcut whose media is still being fetched: keep Steam's placeholder rows loading (they animate
                // while this call is pending) and answer when the feed is ready.
                const appid = toShortcutId(args[0]);
                if (appid !== undefined && Number(args[1]) <= 1 && !settled.has(appid)) {
                    served++;
                    return firstPageHold.hold(appid);
                }
                return callOriginal;
            }
            served++;
            return Promise.resolve(answer);
        } catch (err) {
            deps.reportError("community", err); // fail-open: Steam's own loader
            return callOriginal;
        }
    });
    // Load the first page when Steam binds or resizes the loader (see core.shouldLoadFirstPage): Steam's own triggers miss
    // when the observer's first callback comes after its 1 s timer. LoadAdditionalContent is guarded by Steam's state.
    const loadFirstPage = function (this: unknown, _args: unknown[], ret: unknown): unknown {
        try {
            const loader = this as { LoadAdditionalContent?: () => void; m_nNextPage?: unknown; m_bHasEmptyRows?: unknown; m_unAppID?: unknown };
            if (deps.isEnabled("community") && typeof loader.LoadAdditionalContent === "function" && shouldLoadFirstPage(loader, (appid) => feeds.has(appid) || !settled.has(appid))) {
                firstPageLoads++;
                loader.LoadAdditionalContent();
            }
        } catch (err) {
            deps.reportError("community", err); // fail-open: Steam's own triggers still run
        }
        return ret;
    };
    const bindPatch = typeof proto.OnBind === "function" ? afterPatch(proto, "OnBind", loadFirstPage) : undefined;
    const resizePatch = typeof proto.OnResize === "function" ? afterPatch(proto, "OnResize", loadFirstPage) : undefined;
    // Steam reuses the section for the next app but keeps the old loader (core.loaderIsStale): give it a fresh one.
    const sectionProto = (section as unknown as { prototype: Record<string, unknown> }).prototype;
    const updatePatch =
        typeof sectionProto.componentDidUpdate === "function"
            ? afterPatch(sectionProto, "componentDidUpdate", function (this: SectionInstance, args: unknown[], ret: unknown): unknown {
                  try {
                      if (deps.isEnabled("community")) rebuildStaleLoader(this, (args[0] as { appid?: unknown } | undefined)?.appid);
                  } catch (err) {
                      deps.reportError("community", err); // fail-open: Steam's own (stale) loader
                  }
                  return ret;
              })
            : undefined;
    unpatchLoader = () => {
        for (const p of [updatePatch, resizePatch, bindPatch, patch]) p?.unpatch();
    };
    lastJsx = hook?.diagnostics() ?? [];
    hook?.dispose(); // learned: the jsx observer is not needed any more
    hook = undefined;
    logger.info("Community Content loader patched.");
}

/** A component that renders nothing (Steam's vote, award, comment and Report controls on our cards). */
const Nothing = (): null => null;
type Wrapper = (props: Record<string, any>) => unknown;
const wrappers = new WeakMap<object, Wrapper>();
function wrapped(type: object, make: (type: any) => Wrapper): Wrapper {
    let w = wrappers.get(type); // one stable component per Steam type: a new one each render would remount the subtree
    if (!w) {
        w = make(type);
        wrappers.set(type, w);
    }
    return w;
}

/** Keys for the wrappers of Steam's plain `div` and `img` elements (a string type cannot key the WeakMap). */
const LABEL_KEY = {};
const IMAGE_KEY = {};
const SCROLL_KEY = {};

/**
 * Called while one of our viewers renders: counts it open until it unmounts. A hook, so it needs Steam's own React
 * (`SP_REACT`); without it the viewer-only tweaks stay off and Steam's viewer shows as it is.
 */
function trackOpenViewer(): void {
    const R = Reflect.get(globalThis, "SP_REACT") as { useRef?: (v: unknown) => { current: boolean }; useEffect?: (f: () => () => void, d: unknown[]) => void } | undefined;
    if (!R?.useRef || !R.useEffect) return;
    const counted = R.useRef(false);
    if (!counted.current) {
        counted.current = true;
        openViewers++;
    }
    R.useEffect(() => () => void (openViewers = Math.max(0, openViewers - 1)), []);
}

function accountOfPersona(persona: any): number | undefined {
    const id = persona?.m_steamid;
    return typeof id?.GetAccountID === "function" ? id.GetAccountID() : undefined;
}

/**
 * Steam's own components for our cards and their image viewer, adjusted for content Valve does not know
 * (ADR-0046): no vote, award, comment or Report controls; the viewer gets a creator and a date, and no comment thread;
 * the made-up creator accounts show the source's name and icon. Every check is a few property reads (guardrail 2).
 */
function installCards(): void {
    if (cardsHook) return;
    const runtime = jsxRuntime();
    if (!runtime) {
        logger.warn("react/jsx-runtime not found; Steam's card controls stay on our cards.");
        return;
    }
    const jsx = (type: unknown, props: Record<string, unknown>, key?: string) => (runtime.jsx as (t: unknown, p: unknown, k?: string) => unknown)(type, props, key);
    ManualPages = createManualPages(jsx, {
        manualOf: (appid, key) => deps.manualOf(appid, key),
        subscribe: (listener) => deps.onManuals(listener),
        opened: (appid, key) => deps.bus.emit("community.manual-opened", { appid: appid as ShortcutId, key }),
    });
    cardsHook = keepJsxPatched(runtime, {
        label: "steam-cartridges.community-cards",
        replaceType: (type, props) => {
            try {
                const p = props as Record<string, any> | null | undefined;
                if (!p || typeof p !== "object") return undefined;
                if (typeof type === "string") {
                    if (!deps.isEnabled("community")) return undefined;
                    if (isPlaceholderAppIcon(type, p)) return "span";
                    if (openViewers > 0) {
                        if (isDateRow(type, p)) return Nothing;
                        if (isScrollLabel(type, p)) {
                            return wrapped(SCROLL_KEY, () => (q) =>
                                jsx("div", { ...q, children: (q.children as unknown[]).map((child) => (typeof child === "string" ? MANUAL_SCROLL_TEXT : child)) }),
                            );
                        }
                        if (isCreatedByLabel(type, p)) return wrapped(LABEL_KEY, () => (q) => jsx("div", { ...q, children: "Added by" }));
                        if (isViewerImage(type, p, (url) => viewerMeta.has(url))) {
                            return wrapped(IMAGE_KEY, () => (q) => jsx("img", { ...q, style: { ...q.style, maxHeight: VIEWER_IMAGE_MAX_HEIGHT } }));
                        }
                    }
                    return undefined;
                }
                // 1. our cards' controls and gamepad menu
                const card = cardElement(p);
                if (card === "hide") {
                    if (!deps.isEnabled("community")) return undefined;
                    cardsHidden++;
                    return Nothing;
                }
                if (card === "strip-menu") {
                    return deps.isEnabled("community")
                        ? wrapped(type as object, (T) => (q) => jsx(T, { ...q, onMenuButton: undefined, onMenuActionDescription: undefined }))
                        : undefined;
                }
                if (card === "strip-click") {
                    return deps.isEnabled("community")
                        ? wrapped(type as object, (T) => (q) => jsx(T, { ...q, onClick: undefined }))
                        : undefined;
                }
                // 2. the image viewer Steam opens on a click: the creator and date row, and no comment thread for an unknown file
                if (typeof p.artworkURL === "string" && p.file_details === undefined && viewerMeta.has(p.artworkURL)) {
                    if (!deps.isEnabled("community")) return undefined;
                    return wrapped(type as object, (T) => (q) => {
                        trackOpenViewer();
                        const meta = viewerMeta.get(q.artworkURL);
                        if (!meta) return jsx(T, q);
                        return jsx(T, {
                            ...q,
                            // A manual's pages scroll under its cover; anything else gets no comment thread.
                            children: meta.manual && ManualPages ? jsx(ManualPages, { appid: meta.manual.appid, manualKey: meta.manual.key }) : undefined,
                            // No appid: Steam would look up app info for a non-Steam app and assert (verified live 2026-09-30).
                            appid: undefined,
                            file_details: { creator: CREATOR_STEAMIDS[meta.source], time_created: meta.seconds, file_description: "" },
                        });
                    });
                }
                // 3. "Created by": the avatar and the name of our made-up accounts
                if (p.friend !== undefined && sourceOfAccount(p.friend?.m_unAccountID)) {
                    return wrapped(type as object, () => (q) =>
                        jsx("img", {
                            src: CREATOR_AVATARS[sourceOfAccount(q.friend?.m_unAccountID) ?? "igdb"],
                            style: { width: 36, height: 36, borderRadius: 4 },
                        }),
                    );
                }
                if (p.persona !== undefined && "bParenthesizeNicknames" in p && sourceOfAccount(accountOfPersona(p.persona))) {
                    return wrapped(type as object, () => (q) =>
                        jsx("span", { className: q.className, children: CREATOR_NAMES[sourceOfAccount(accountOfPersona(q.persona)) ?? "igdb"] }),
                    );
                }
            } catch (err) {
                deps.reportError("community", err); // fail-open: Steam's own element
            }
            return undefined;
        },
    });
}

function forgetViewerMeta(appid: number): void {
    for (const url of viewerUrlsByApp.get(appid) ?? []) viewerMeta.delete(url);
    viewerUrlsByApp.delete(appid);
}

/** The viewer opens the image a card shows: remember which source and date belong to that URL. Videos open YouTube instead. */
function rememberViewerMeta(
    appid: number,
    feed: FeedItem[],
    checkedAtMs: number,
    manualsByUrl: ReadonlyMap<string, { appid: number; key: string }>,
    manualKeys: readonly string[],
): void {
    forgetViewerMeta(appid);
    const urls: string[] = [];
    const seconds = Math.floor(checkedAtMs / 1000);
    for (const card of feed) {
        if (card.type === 4) continue;
        const source = (Object.keys(CREATOR_STEAMIDS) as MediaItem["source"][]).find((s) => CREATOR_STEAMIDS[s] === card.creator.steamid);
        if (!source) continue;
        viewerMeta.set(card.full_image_url, { source, seconds, manual: manualsByUrl.get(card.full_image_url) ?? manualOfUrl(card.full_image_url) });
        urls.push(card.full_image_url);
    }
    // A manual's card can hold either cover (Steam keeps the feed it was served, which may predate the first-page cover):
    // both URLs open the manual's pages.
    for (const key of manualKeys) {
        const placeholder = manualCoverUrl(appid, key);
        if (viewerMeta.has(placeholder)) continue;
        viewerMeta.set(placeholder, { source: "screenscraper", seconds, manual: { appid, key } });
        urls.push(placeholder);
    }
    viewerUrlsByApp.set(appid, urls);
}

/** Install the learn-once jsx observer. Idempotent; a failure leaves the section stock. */
export function installCommunity(): void {
    if (hook || unpatchLoader) return;
    const runtime = jsxRuntime();
    if (!runtime) throw new Error("react/jsx-runtime not found; community media stays off.");
    hook = keepJsxPatched(runtime, {
        label: "steam-cartridges.community",
        observe: (type, props) => {
            if (learnScheduled || !deps.isEnabled("community")) return;
            try {
                if (!isContentSection(type, props)) return;
                learnScheduled = true;
                // Never patch from inside Steam's render (D5): the next tick, well before the first page (>= 1 s).
                setTimeout(() => {
                    try {
                        patchLoader(type as new (props: unknown) => { m_loader?: object });
                    } catch (err) {
                        deps.reportError("community", err);
                        logger.warn("Community Content loader not patched; the section stays stock.", err);
                    }
                }, 0);
            } catch (err) {
                deps.reportError("community", err);
            }
        },
    });
}

/** For CDP checks (PLUGIN_LIST[...].communityDiagnostics()). */
export function communityDiagnostics(): {
    patched: boolean;
    feeds: Record<number, number>;
    served: number;
    firstPageLoads: number;
    loaderRebuilds: number;
    cardsHidden: number;
    cardsHook: boolean;
    jsx: JsxHookDiagnostics[];
} {
    const counts: Record<number, number> = {};
    feeds.forEach((feed, appid) => (counts[appid] = feed.length));
    return { patched: !!unpatchLoader, feeds: counts, served, firstPageLoads, loaderRebuilds, cardsHidden, cardsHook: !!cardsHook, jsx: hook?.diagnostics() ?? lastJsx };
}

export function createCommunitySurface(d: CommunityDeps): Surface {
    deps = d;
    return {
        id: "community",
        touches: ["CommunityContentLoader.LoadCommunityContentAndVotes", "jsx:community-section"],
        reads: ["media"],
        install: installCommunity,
        render(appid: ShortcutId, record) {
            const media = record?.media;
            const items: MediaItem[] = media?.status === "ok" && Array.isArray(media.data?.items) ? media.data!.items : [];
            if (items.length === 0) {
                forgetViewerMeta(appid);
                feeds.delete(appid);
                if (media && media.status !== "pending") {
                    settled.add(appid); // nothing will come: Steam is told there is no content
                    firstPageHold.release(appid);
                }
                return;
            }
            const feed = toFeedItems(appid, items, (key) => deps.imageOf(appid, key), (key) => deps.coverOf(appid, key));
            feeds.set(appid, feed);
            // A manual's cover is its first page (a blob: URL): the viewer finds the manual by that URL.
            const manualsByUrl = new Map<string, { appid: number; key: string }>();
            for (const item of items) {
                const cover = item.kind === "manual" && item.key ? deps.coverOf(appid, item.key) : undefined;
                if (cover) manualsByUrl.set(cover, { appid, key: item.key! });
            }
            const manualKeys = items.filter((item) => item.kind === "manual" && item.key).map((item) => item.key!);
            rememberViewerMeta(appid, feed, typeof media?.checkedAt === "number" ? media.checkedAt : Date.now(), manualsByUrl, manualKeys);
            installCards();
            // Serve the feed once its manual has the first-page cover, or after COVER_WAIT_MS (the cover job reads a PDF).
            const coverMissing = manualKeys.some((key) => !deps.coverOf(appid, key));
            if (coverMissing && coverWait.get(appid) !== "done") {
                if (!coverWait.has(appid)) {
                    coverWait.set(appid, "waiting");
                    setTimeout(() => {
                        coverWait.set(appid, "done");
                        settled.add(appid);
                        firstPageHold.release(appid);
                    }, COVER_WAIT_MS);
                }
                return;
            }
            coverWait.set(appid, "done");
            settled.add(appid);
            firstPageHold.release(appid);
        },
        clear: (appid) => {
            forgetViewerMeta(appid);
            feeds.delete(appid);
            settled.delete(appid);
            coverWait.delete(appid);
            firstPageHold.release(appid);
        },
        uninstall() {
            unpatchLoader?.();
            unpatchLoader = undefined;
            hook?.dispose();
            hook = undefined;
            cardsHook?.dispose();
            cardsHook = undefined;
            learnScheduled = false;
            firstPageHold.releaseAll();
            settled.clear();
            coverWait.clear();
            feeds.clear();
            viewerMeta.clear();
            viewerUrlsByApp.clear();
            openViewers = 0;
        },
    };
}
