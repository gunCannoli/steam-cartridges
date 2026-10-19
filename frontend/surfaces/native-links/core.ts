/**
 * Pure part of the section appid redirection (parity plan C). Its one import (the kernel)
 * carries `.ts`, so Node can run the unit tests with type stripping.
 *
 * Steam's own Links, Friends and Community sections load their data by appid
 * (`overview.appid`, `details.unAppID`, `appid`). For a shortcut with a Steam
 * match we hand them the native appid, so Steam fetches and renders the native
 * game's links, friends who play and community content itself (ADR-0022,
 * ADR-0009). A shortcut without a match gets Steam's stock behaviour: no links
 * (a shortcut's own appid has no store page).
 */
import { NON_STEAM_APPID_MIN } from '../../kernel/appid.ts';

export type RedirectKind = 'links' | 'friends' | 'community' | 'event';


const proxies = new WeakMap<object, Map<number, object>>();

/** One proxy per (target, native) so React sees a stable object across renders. */
function cached<T extends object>(target: T, key: number, make: () => T): T {
    let byKey = proxies.get(target);
    if (!byKey) {
        byKey = new Map();
        proxies.set(target, byKey);
    }
    let p = byKey.get(key) as T | undefined;
    if (!p) {
        p = make();
        byKey.set(key, p);
    }
    return p;
}

/** Reads go to the target (getters run with the target as `this`); methods stay bound to it. */
function passThrough(t: object, prop: string | symbol): unknown {
    const v = Reflect.get(t, prop, t);
    return typeof v === 'function' ? v.bind(t) : v;
}

/** The overview the Links component sees. native undefined = stock shortcut behaviour (no links). */
export function linksOverview<T extends object>(overview: T, native: number | undefined): T {
    return cached(overview, native ?? 0, () =>
        new Proxy(overview, {
            get(t, prop) {
                if (prop === 'BIsModOrShortcut') return native === undefined ? () => true : () => false;
                if (native !== undefined && prop === 'appid') return native;
                return passThrough(t, prop);
            },
        }),
    );
}

/** The details the Friends components see: `unAppID` is the native app. */
export function nativeDetails<T extends object>(details: T, native: number): T {
    return cached(details, native, () =>
        new Proxy(details, {
            get(t, prop) {
                if (prop === 'unAppID') return native;
                return passThrough(t, prop);
            },
        }),
    );
}

/**
 * Rewrite one element's props in place (the jsx hook passes the props object
 * before React sees it). Returns the native appid used, or undefined when
 * nothing changed. O(1).
 */
export function redirectProps(
    kind: RedirectKind,
    props: Record<string, any> | null | undefined,
    nativeOf: (appid: number) => number | undefined,
): number | undefined {
    if (!props) return undefined;
    if (kind === 'links') {
        const ov = props.overview;
        if (!ov || typeof ov !== 'object' || !(ov.appid >= NON_STEAM_APPID_MIN)) return undefined;
        const native = nativeOf(ov.appid);
        props.overview = linksOverview(ov, native);
        return native ?? 0;
    }
    if (kind === 'friends') {
        const d = props.details;
        if (!d || typeof d !== 'object' || !(d.unAppID >= NON_STEAM_APPID_MIN)) return undefined;
        const native = nativeOf(d.unAppID);
        if (native === undefined) return undefined;
        props.details = nativeDetails(d, native);
        return native;
    }
    // community (Community Content `{appid}`) and event (partner event overlay
    // `{appid, initialEventID}`, which renders only when appid is the event's app).
    const appid = props.appid;
    if (!(appid >= NON_STEAM_APPID_MIN)) return undefined;
    const native = nativeOf(appid);
    if (native === undefined) return undefined;
    props.appid = native;
    return native;
}

/**
 * Where Steam's `Navigator.App(appid)` should go (parity plan G2). It returns
 * early for an appid missing from appStore, which is every unowned native app,
 * so a click on a native news card or on the event overlay's app icon does
 * nothing (live 2026-09-25). For a native app mapped from a shortcut, open the
 * shortcut instead. Undefined = leave the call alone. O(1).
 */
export function navigationTarget(
    appid: unknown,
    isKnown: (appid: number) => boolean,
    shortcutOf: (nativeAppid: number) => number | undefined,
): number | undefined {
    if (typeof appid !== 'number' || appid >= NON_STEAM_APPID_MIN) return undefined;
    const shortcut = shortcutOf(appid);
    if (shortcut === undefined || isKnown(appid)) return undefined;
    return shortcut;
}

/**
 * Strips the 'Support' (*helpwithgame*) link from the game info links bar
 * for non-native games (shortcuts, whether mapped to a native app or unmapped).
 * Real native games retain their support link unchanged.
 */
export function cleanLinksProps(
    props: Record<string, any> | null | undefined,
    isShortcutOrMapped: (appid: number) => boolean,
): boolean {
    if (!props || !Array.isArray(props.links)) return false;
    const links = props.links as Array<{ link?: string; url?: string; appid?: number }>;
    const hasSupport = links.some(
        (l) => l?.link === 'HelpAppPage' || String(l?.url || '').includes('HelpWithGame') || String(l?.url || '').includes('help.steampowered.com')
    );
    if (!hasSupport) return false;

    const targetAppid = props.overview?.appid ?? links.find((l) => typeof l.appid === 'number')?.appid;
    if (typeof targetAppid === 'number' && (targetAppid >= NON_STEAM_APPID_MIN || isShortcutOrMapped(targetAppid))) {
        props.links = links.filter(
            (l) => l?.link !== 'HelpAppPage' && !String(l?.url || '').includes('HelpWithGame') && !String(l?.url || '').includes('help.steampowered.com')
        );
        return true;
    }
    return false;
}

/**
 * K4: Steam's "Mark as Private" menu item (module 5808) is disabled when any of its `rgApps` reports
 * `BIsModOrShortcut()`. The Game Info proxy (guardrail 1) says false for an enriched shortcut, which
 * enabled the item and would send the shortcut's fake appid to the private-apps service. Give the item
 * apps that report true for shortcuts, so Steam disables it itself, as for any other shortcut.
 */
const shortcutMenuApps = new WeakMap<object, object>();

export function shortcutSafeApps<T extends { appid?: number }>(rgApps: readonly T[]): T[] {
    return rgApps.map((app) => {
        if (!app || typeof app.appid !== 'number' || (app.appid >>> 0) < NON_STEAM_APPID_MIN) return app;
        let p = shortcutMenuApps.get(app);
        if (!p) {
            p = new Proxy(app, {
                get(t, prop) {
                    if (prop === 'BIsModOrShortcut') return () => true;
                    return passThrough(t, prop);
                },
            });
            shortcutMenuApps.set(app, p);
        }
        return p as T;
    });
}

/** The component source that identifies the "Mark as Private" item (its localisation token). */
export const MARK_PRIVATE_SOURCE = 'GameAction_MarkAsPrivate_NoShortcuts';
