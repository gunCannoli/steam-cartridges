// Surface `game-info`, part `playbar` (migration plan M3.4; M10: back inside game-info, whose hooks it
// uses, under its own kill switch `playbar`): restores the ⓘ "Show/Hide game details" button on a
// shortcut's desktop PlayBar (hookComponentProps with requireMetadata: false, and the PlayBar render
// fallback). The button opens Game Info, so it is on only while both `playbar` and `game-info` are.
import { logger } from "../../logger";
import { resolveOnce } from "../../steam/modules";
import { createPatchedOverview } from "../../steam/overview-proxy";
import { isShortcutAppId } from "../../kernel/appid";
import { deps } from "./deps";
import { ensureAppOverviewHooked, trackInstance } from "./patch";

const on = () => deps.isEnabled("playbar") && deps.isEnabled("game-info");

function isShortcutOverview(overview: any): boolean {
    return (
        isShortcutAppId(overview.appid) ||
        (typeof overview.BIsModOrShortcut === "function" && overview.BIsModOrShortcut())
    );
}

/** The requireMetadata: false path of game-info's hookComponentProps, for the PlayBar class. */
function hookPlayBarProps(componentClass: any): void {
    if (componentClass.__nsga_props_hooked) return;
    // game-info's refreshGameInfoInstances finds hooked components by this flag.
    componentClass.__nsga_props_hooked = true;
    try {
        Object.defineProperty(componentClass.prototype, "props", {
            get() {
                if (!on()) return this._nsga_raw_props;
                try {
                    trackInstance(this);
                    const rawProps = this._nsga_raw_props;
                    if (!rawProps) return rawProps;
                    const overview = rawProps.overview;
                    if (!overview) return rawProps;
                    ensureAppOverviewHooked(overview);

                    if (isShortcutOverview(overview)) {
                        if (
                            this._nsga_patched_props &&
                            this._nsga_last_raw_props === rawProps
                        ) {
                            return this._nsga_patched_props;
                        }
                        this._nsga_last_raw_props = rawProps;
                        this._nsga_patched_props = new Proxy(rawProps, {
                            get(target, prop, receiver) {
                                if (prop === "overview") {
                                    return createPatchedOverview(overview);
                                }
                                return Reflect.get(target, prop, receiver);
                            },
                        });
                        return this._nsga_patched_props;
                    }
                    return rawProps;
                } catch (err) {
                    deps.reportError("playbar", err); // fail-open (plan § 7.0 D6)
                    return this._nsga_raw_props;
                }
            },
            set(newProps) {
                this._nsga_raw_props = newProps;
                this._nsga_last_raw_props = undefined;
                this._nsga_patched_props = undefined;
            },
            configurable: true,
        });
    } catch (e) {
        logger.warn("Could not define props descriptor on component:", e);
    }
}

/** Every live page header, so the setting can be applied to the open pages at once. */
const headers = new Set<WeakRef<any>>();
let headerClass: any;

/** The start state wanted for a page: the setting on opens Game Info everywhere; off keeps an owned game's start, and gives a shortcut the same. */
function wantedStart(overview: any, visible: Set<number>, steamsStart: boolean): boolean {
    if (!on()) return steamsStart;
    if (deps.showByDefault()) return true;
    return isShortcutOverview(overview) ? visible.has(overview.appid) : steamsStart;
}

/**
 * Steam opens Game Info for any shortcut: the page header's constructor starts `bShowGameInfo` as
 * `BIsModOrShortcut() || visible.has(appid)`, an owned game's start is collapsed behind the ⓘ button until the user opens
 * it. Setting `showGameInfoByDefault` off: a shortcut gets the owned game's start; on: every page starts open. The
 * constructor's first `this.state = ...` is the one place to change it before the first paint, so `state` becomes an accessor
 * that edits that first value only; the ⓘ button's own toggle and React's later state writes pass through untouched.
 */
function patchGameInfoStart(): void {
    const header = resolveOnce<any>(
        'Game Info page header (start state)',
        (v) =>
            typeof v === 'function' &&
            (v as any).s_setGameInfoVisible instanceof Set &&
            typeof (v as any).prototype?.onGameInfoToggle === 'function' &&
            typeof (v as any).prototype?.OnHeaderWaypointLeave === 'function',
    );
    if (!header || header.__nsga_start_patched) return;
    header.__nsga_start_patched = true;
    headerClass = header;
    const visible = header.s_setGameInfoVisible as Set<number>;
    try {
        Object.defineProperty(header.prototype, 'state', {
            get() {
                return this._nsga_state;
            },
            set(next) {
                if (!this._nsga_state_seen) {
                    this._nsga_state_seen = true;
                    headers.add(new WeakRef(this));
                    try {
                        const overview = this.props?.overview;
                        if (overview && next && typeof next.bShowGameInfo === 'boolean') {
                            const want = wantedStart(overview, visible, next.bShowGameInfo);
                            if (want !== next.bShowGameInfo) next = { ...next, bShowGameInfo: want };
                        }
                    } catch (err) {
                        deps.reportError('playbar', err); // fail-open: Steam's own start
                    }
                }
                this._nsga_state = next;
            },
            configurable: true,
        });
        // Steam reuses the same header when the user goes straight from one game to another, and the constructor
        // does not run again: give the new game its own start too.
        const origDidUpdate = header.prototype.componentDidUpdate;
        header.prototype.componentDidUpdate = function (prevProps: any, ...rest: any[]) {
            const result = typeof origDidUpdate === 'function' ? origDidUpdate.call(this, prevProps, ...rest) : undefined;
            try {
                const overview = this.props?.overview;
                if (overview && prevProps?.overview && prevProps.overview.appid !== overview.appid && this.state) {
                    const steamsStart = isShortcutOverview(overview) || visible.has(overview.appid);
                    const want = wantedStart(overview, visible, steamsStart);
                    if (this.state.bShowGameInfo !== want) this.setState({ bShowGameInfo: want, suppressTransition: true });
                }
            } catch (err) {
                deps.reportError('playbar', err);
            }
            return result;
        };
        logger.info('Game Info start state patched (setting showGameInfoByDefault).');
    } catch (e) {
        logger.warn('Could not define state on the Game Info page header:', e);
    }
}

/** The setting changed: open or close Game Info on every page that is open now (a page opened later reads the setting itself). */
export function applyGameInfoDefault(): void {
    if (!headerClass) return;
    const visible = headerClass.s_setGameInfoVisible as Set<number>;
    for (const ref of [...headers]) {
        const inst = ref.deref();
        if (!inst) {
            headers.delete(ref);
            continue;
        }
        try {
            const overview = inst.props?.overview;
            if (!overview || !inst.state) continue;
            const want = deps.showByDefault() ? true : visible.has(overview.appid);
            if (inst.state.bShowGameInfo !== want) inst.setState({ bShowGameInfo: want, suppressTransition: false });
        } catch (err) {
            deps.reportError('playbar', err);
        }
    }
}

/**
 * Steam's own Play Time and Last Played stats (the play bar's GameStatsSection: `Ie` reads details.nPlaytimeForever, `ht`
 * details.rtLastTimePlayed; Steam 1794424036) with a shortcut's tracked playtime (app/playtime). A Proxy over Steam's details,
 * not a copy: every other field, and MobX's tracking of them, stays Steam's. Steam's stores are never written, so Steam's own
 * details refresh cannot undo it. No tracked entry: Steam's details as they are.
 */
const detailsProxies = new WeakMap<object, { key: string; proxy: object }>();
function withPlaytime(details: any, appid: unknown): any {
    if (!details || typeof details !== "object") return details;
    const p = deps.playtimeOf(Number(appid));
    if (!p) return details;
    const key = `${p.minutes}:${p.last_played}`;
    const cached = detailsProxies.get(details);
    if (cached && cached.key === key) return cached.proxy;
    const proxy = new Proxy(details, {
        get(target, prop, receiver) {
            if (prop === "nPlaytimeForever") return p.minutes;
            if (prop === "rtLastTimePlayed" && p.last_played > 0) return p.last_played;
            return Reflect.get(target, prop, receiver === proxy ? target : receiver);
        },
    });
    detailsProxies.set(details, { key, proxy });
    return proxy;
}

/**
 * The steam-non-steam-playtimes plugin injects its own copy of these stats into the play bar, with a <style> that hides
 * Steam's own while its copy is in the page. With ours on, its nodes are removed whenever it adds them (it re-adds on
 * every page and heartbeat). One observer per window document; it does nothing once the setting is off.
 */
const observedDocs = new WeakSet<Document>();
function hideOtherPlaytime(): void {
    if (!deps.hideOtherPlaytime()) return;
    try {
        const windows = (globalThis as any).SteamUIStore?.WindowStore?.SteamUIWindows ?? [];
        for (const w of windows) {
            const doc: Document | undefined = w?.BrowserWindow?.document;
            if (!doc?.body || observedDocs.has(doc)) continue;
            observedDocs.add(doc);
            const sweep = () => doc.querySelectorAll("[data-nsp]").forEach((n) => n.remove());
            sweep();
            new MutationObserver((records) => {
                if (!deps.hideOtherPlaytime()) return;
                for (const r of records) {
                    for (const n of r.addedNodes) {
                        if (n.nodeType === 1 && (n as Element).hasAttribute("data-nsp")) {
                            (n as Element).remove();
                        }
                    }
                }
            }).observe(doc.body, { childList: true, subtree: true });
        }
    } catch (err) {
        deps.reportError("playbar", err);
    }
}

export function patchPlayBar(): void {
    patchGameInfoStart();
    const targetPlayBar = resolveOnce<any>(
        "PlayBar component",
        (v) => typeof v === "function" && (v as any).s_setGameInfoVisible instanceof Set && Array.isArray((v as any).s_rgFakeDetails),
    );
    if (!targetPlayBar || targetPlayBar.__nsga_playbar_patched) return;
    targetPlayBar.__nsga_playbar_patched = true;
    hookPlayBarProps(targetPlayBar);

    const origPlayBarRender = targetPlayBar.prototype.render;
    if (typeof origPlayBarRender === "function") {
        targetPlayBar.prototype.render = function () {
            if (!on()) return origPlayBarRender.apply(this, arguments);
            try {
                trackInstance(this);
                const overview = this.props?.overview;
                if (overview) {
                    ensureAppOverviewHooked(overview);
                }
                if (overview && isShortcutOverview(overview)) {
                    this.props = {
                        ...this.props,
                        overview: createPatchedOverview(overview),
                        details: withPlaytime(this.props?.details, overview.appid),
                    };
                    hideOtherPlaytime();
                }
            } catch (err) {
                deps.reportError("playbar", err); // fail-open (plan § 7.0 D6)
            }
            return origPlayBarRender.apply(this, arguments);
        };
    }
    logger.info(
        "Successfully patched Steam PlayBar component (show/hide game details ⓘ button restored).",
    );
}
