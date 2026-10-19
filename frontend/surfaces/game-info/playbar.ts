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

export function patchPlayBar(): void {
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
                    };
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
