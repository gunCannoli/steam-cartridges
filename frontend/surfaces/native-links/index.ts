// Surface `native-links` (migration plan M3.7, ADR-0039). Moved from
// features/steam-store/native-sections.ts; pure logic in core.ts (ex native-sections-core.ts).
import { afterPatch, beforePatch } from "@steambrew/client";
import { logger } from "../../logger";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { keepJsxPatched, type JsxHookDiagnostics } from "../../steam/jsx-hook";
import { jsxRuntime, steamRequire } from "../../steam/modules";
import { cleanLinksProps, MARK_PRIVATE_SOURCE, navigationTarget, redirectProps, shortcutSafeApps, type RedirectKind } from "./core";

/** Set by createNativeLinksSurface (plan § 7.0 D6); open defaults until then. */
let deps: SurfaceDeps = { isEnabled: () => true, reportError: () => {} };

/**
 * Hands Steam's own Links, Friends and Community sections the native appid of
 * a mapped shortcut (parity plan C; pure logic in core.ts).
 *
 * The three components are resolved ONCE at startup (guardrail 3) by their
 * webpack factory source, keyed on localisation tokens (steam-debug.md § 3.2).
 * Each signature must match exactly one module, or that kind is skipped and
 * the section stays stock. Verified 2026-09-24: links -> module exporting the
 * links bar used by desktop and Big Picture Game Info; friends -> the module
 * with the Friends section (desktop `{details}`, Big Picture `{details}`);
 * community -> the Community Content section (`{appid}`). Verified 2026-09-25:
 * event -> the partner event overlay (`{appid, initialEventID}`, desktop and
 * Big Picture), which renders only when `appid` is the event's own app.
 *
 * The jsx handler is O(1) (guardrail 2): one Map lookup on the element type,
 * then one on the appid.
 */
const SIGNATURES: [RedirectKind, string[]][] = [
    ["links", ['"#AppDetails_Links_Store"', '"primarylinks"']],
    ["friends", ['"CommunityFriendsThatPlay"', '"#AppDetails_SectionTitle_Friends"']],
    ["community", ['"#AppDetails_SectionTitle_Community"', "LoadAdditionalContent"]],
    ["event", ['"LibraryAppPartnerEventsPage unmounting"', "LoadAdjacentPartnerEvents"]],
];

/** Element type -> kind. Every export of a matched module (only matching props are touched). */
const TYPES = new Map<unknown, RedirectKind>();
/** Shortcut appid -> native appid, for mapped steam-store games. */
const nativeFor = new Map<number, number>();
const counts: Record<RedirectKind, number> = { links: 0, friends: 0, community: 0, event: 0 };
const lastNative: Partial<Record<RedirectKind, number>> = {};
/** Native appid -> shortcut appid, for the Navigator.App redirect (parity plan G2). */
const shortcutFor = new Map<number, number>();

export function setNativeAppid(appid: number, nativeAppid: number | undefined): void {
    const previous = nativeFor.get(appid);
    if (previous !== undefined && shortcutFor.get(previous) === appid) shortcutFor.delete(previous);
    if (nativeAppid === undefined) {
        nativeFor.delete(appid);
        return;
    }
    nativeFor.set(appid, nativeAppid);
    shortcutFor.set(nativeAppid, appid);
    wrapNavigators();
    wrapAppOverviewLookup();
}

const nativeOf = (appid: number) => nativeFor.get(appid);

/** Is this jsx type Steam's "Mark as Private" menu item (K4)? Decided once per component from its source. */
const markPrivate = new WeakMap<object, boolean>();
function isMarkPrivateItem(type: unknown): boolean {
    if (typeof type !== "function") return false;
    let known = markPrivate.get(type);
    if (known === undefined) {
        try {
            known = Function.prototype.toString.call(type).includes(MARK_PRIVATE_SOURCE);
        } catch {
            known = false;
        }
        markPrivate.set(type, known);
    }
    return known;
}

/** Navigators already patched (one per Steam UI window: desktop, Big Picture). */
const wrappedNavigators = new WeakSet<object>();
let navigatorPatches = 0;
let navRedirects = 0;

/**
 * Marks `UNOWNED_NATIVE_APP_FALLBACK` so every OTHER consumer of
 * `GetAppOverviewByAppID` besides the Friends crash (isKnownApp included) can
 * tell it apart from a real AppOverview and keep treating that appid as
 * unowned/unknown. Without this tag, `isKnownApp` (used by
 * `navigationTarget` below) saw the fallback's truthiness and treated the
 * unowned native app as "known", which suppressed the Navigator.App ->
 * shortcut redirect and regressed check 16 in steam-cartridges/tests/live/check_parity.mjs
 * (found live 2026-09-26 while executing this fix — see
 * steam-cartridges-friends-boat-crash.md § 12).
 */
const FALLBACK_TAG = Symbol("steam-cartridges.unowned-native-app-fallback");

const isKnownApp = (appid: number): boolean => {
    const overview = (window as any).appStore?.GetAppOverviewByAppID?.(appid);
    return !!overview && (overview as any)[FALLBACK_TAG] !== true;
};

/**
 * Duck-typed fallback for a mapped native app Steam has no AppOverview for
 * (the native game is unowned). Steam's own Friends section (module 2326,
 * function `ne`) calls `appStore.GetAppOverviewByAppID(appid).BIsApplicationOrTool()`
 * with no null guard, and only ever reads that one method off the result
 * (confirmed live 2026-09-26, all 3 call sites in that module — see
 * steam-cartridges-friends-boat-crash.md § 1/§ 4). `false` is correct, not
 * just safe: a mapped native app is a game, never a "tool" (ADR-0038).
 * Tagged with FALLBACK_TAG (see above) so it never masquerades as a real,
 * owned AppOverview to any other consumer of the same store method.
 */
const UNOWNED_NATIVE_APP_FALLBACK = { BIsApplicationOrTool: () => false, [FALLBACK_TAG]: true };

/** appStore.GetAppOverviewByAppID already patched (idempotent, one appStore). */
let appOverviewPatched = false;

/**
 * Patch `appStore.GetAppOverviewByAppID` once so a call for one of our own
 * mapped *native* appids never returns null to Steam's own code — only for
 * appids in `shortcutFor` (i.e. appids our Friends/links/community redirect
 * can ever hand to Steam), and only when the real result is already null.
 * Every other appid, including an unmapped one or the same native appid once
 * it becomes owned, falls through to the real AppOverview unchanged.
 *
 * Deliberately patches the READ METHOD, never `appStore.m_mapApps` itself
 * (that map is the shared, globally-enumerated backing store for the whole
 * library grid/collections UI — a same-prototype stub inserted there broke
 * library-wide rendering in an earlier attempt at this fix; see
 * steam-cartridges-friends-boat-crash.md § 2 Attempt 2). Mirrors
 * wrapNavigators() below and plugins.md guardrail 5.3's "Immunize via
 * Prototype Hook" pattern (hook the method, not the shared map).
 */
function wrapAppOverviewLookup(): void {
    if (appOverviewPatched) return;
    const store = (window as any).appStore;
    if (!store || typeof store.GetAppOverviewByAppID !== "function") return;
    try {
        afterPatch(store, "GetAppOverviewByAppID", (args: unknown[], ret: unknown) => {
            if (!deps.isEnabled("native-links")) return ret;
            try {
                if (ret !== null && ret !== undefined) return ret;
                const appid = args[0];
                if (typeof appid !== "number" || !shortcutFor.has(appid)) return ret;
                return UNOWNED_NATIVE_APP_FALLBACK;
            } catch (err) {
                deps.reportError("native-links", err); // fail-open (plan § 7.0 D6)
                return ret;
            }
        });
        appOverviewPatched = true;
    } catch (err) {
        logger.warn("Could not patch appStore.GetAppOverviewByAppID; unowned native Friends sections may still crash.", err);
    }
}

/**
 * Patch `Navigator.App` of every Steam UI window once (SDK patcher, so the
 * chain stays unpatchable). Steam's native news cards and the event overlay's
 * app icon call `Navigator.App(<native appid>)`, a no-op for an unowned app;
 * a mapped native appid is sent to its shortcut instead. Called on each mapped
 * view (setNativeAppid) and on every shortcut view (index.tsx), so a window created later
 * (Big Picture, or the desktop window after a UI-mode switch) is picked up. Not a hot path.
 */
export function wrapNavigators(): void {
    if (shortcutFor.size === 0) return; // nothing mapped yet: nothing to redirect
    try {
        const windows = (window as any).SteamUIStore?.WindowStore?.SteamUIWindows ?? [];
        for (const w of windows) {
            const nav = w?.Navigator;
            if (!nav || typeof nav.App !== "function" || wrappedNavigators.has(nav)) continue;
            beforePatch(nav, "App", (args: unknown[]) => {
                if (!deps.isEnabled("native-links")) return;
                try {
                    const target = navigationTarget(args[0], isKnownApp, (n) => shortcutFor.get(n));
                    if (target === undefined) return;
                    args[0] = target;
                    navRedirects++;
                } catch (err) {
                    deps.reportError("native-links", err); // fail-open (plan § 7.0 D6)
                }
            });
            wrappedNavigators.add(nav);
            navigatorPatches++;
        }
    } catch (err) {
        logger.warn("Could not patch Steam's Navigator; native links stay stock.", err);
    }
}

function resolveTypes(): void {
    const req = (steamRequire() as any);
    if (!req?.m) {
        logger.warn("Webpack require unavailable; native sections stay stock.");
        return;
    }
    const hits: Record<RedirectKind, string[]> = { links: [], friends: [], community: [], event: [] };
    for (const id of Object.keys(req.m)) {
        let src: string;
        try {
            src = Function.prototype.toString.call(req.m[id]);
        } catch {
            continue;
        }
        for (const [kind, needles] of SIGNATURES) {
            if (needles.every((n) => src.includes(n))) hits[kind].push(id);
        }
    }
    for (const [kind] of SIGNATURES) {
        if (hits[kind].length !== 1) {
            logger.warn(`Native ${kind} section: ${hits[kind].length} module matches (need 1); left stock.`);
            continue;
        }
        let exp: any;
        try {
            exp = req(hits[kind][0]!);
        } catch {
            continue;
        }
        for (const key of Object.keys(exp ?? {})) {
            const v = exp[key];
            if (v && (typeof v === "function" || typeof v === "object")) TYPES.set(v, kind);
        }
    }
}

let hook: ReturnType<typeof keepJsxPatched> | undefined;

/** Resolve the components and install the jsx handler. Idempotent; a failure leaves Steam stock. */
export function installNativeSections(): void {
    if (hook) return;
    try {
        resolveTypes();
        if (TYPES.size === 0) return;
        const runtime = jsxRuntime();
        if (!runtime) {
            logger.warn("Could not find react/jsx-runtime; native sections stay stock.");
            return;
        }
        hook = keepJsxPatched(runtime, {
            label: "steam-cartridges.native-sections",
            observe: (type, props) => {
                if (!deps.isEnabled("native-links")) return;
                try {
                    const p = props as Record<string, any> | null | undefined;
                    if (!p) return;
                    if (Array.isArray(p.links)) {
                        cleanLinksProps(p, (n) => shortcutFor.has(n));
                    }
                    if (Array.isArray(p.rgApps) && isMarkPrivateItem(type)) p.rgApps = shortcutSafeApps(p.rgApps);
                    const kind = TYPES.get(type);
                    if (kind === undefined) return;
                    const used = redirectProps(kind, p, nativeOf);
                    if (used !== undefined) {
                        counts[kind]++;
                        lastNative[kind] = used;
                    }
                } catch (err) {
                    deps.reportError("native-links", err); // fail-open (plan § 7.0 D6)
                }
            },
        });
        logger.info(`Native sections redirect installed (${TYPES.size} component exports).`);
    } catch (err) {
        logger.warn("Native sections redirect failed; sections stay stock.", err);
    }
}

/** For CDP checks (PLUGIN_LIST[...].nativeSectionsDiagnostics()). */
export function nativeSectionsDiagnostics(): {
    kinds: RedirectKind[];
    counts: Record<RedirectKind, number>;
    lastNative: Partial<Record<RedirectKind, number>>;
    mapped: Record<number, number>;
    jsx: JsxHookDiagnostics[];
    navigatorPatches: number;
    navRedirects: number;
} {
    return {
        kinds: [...new Set(TYPES.values())],
        counts: { ...counts },
        lastNative: { ...lastNative },
        mapped: Object.fromEntries(nativeFor),
        jsx: hook?.diagnostics() ?? [],
        navigatorPatches,
        navRedirects,
    };
}

export function createNativeLinksSurface(d: SurfaceDeps): Surface {
    deps = d;
    return {
        id: "native-links",
        touches: ["appStore.GetAppOverviewByAppID", "Navigator.App", "jsx:native-sections"],
        reads: ["identity"],
        install: installNativeSections,
        render(appid, record) {
            setNativeAppid(appid, record?.identity?.data?.native?.appid);
        },
        clear: (appid) => setNativeAppid(appid, undefined),
        uninstall() {
            /* the patches stay until Steam restarts, as before M3.7 */
        },
    };
}
