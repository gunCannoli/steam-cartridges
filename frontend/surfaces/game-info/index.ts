// Surface `game-info` (migration plan M3.3, ADR-0039): the only code that writes Game Info
// into Steam (AppDetailsStore descriptions/associations, overview release date and store
// categories) and hooks Steam's Game Info components. The features reach its API only
// through setters wired in index.tsx (plan § 7.0 D3, D4).
import type { GameMetadata } from "../../kernel/record";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { deps } from "./deps";
import { enrichGameDetails, revertGameDetails } from "./metadata";
import { patchPlayBar } from "./playbar";
import {
    enrichedAppIds,
    ensureAppOverviewHooked,
    gameInfoRepairDiagnostics,
    installOverviewRepair,
    isAppEnriched,
    patchGameInfoComponent,
    refreshGameInfoInstances,
    setCachedStores,
    trackInstance,
} from "./patch";

export { gameInfoRepairDiagnostics, enrichGameDetails, revertGameDetails, isAppEnriched, refreshGameInfoInstances, ensureAppOverviewHooked, trackInstance };

/** What the features call (structurally matched by their setters). */
export const gameInfoWriter = {
    enrich: (appid: number, meta: GameMetadata) => enrichGameDetails(appid, meta),
    revert: (appid: number) => revertGameDetails(appid),
    refresh: () => refreshGameInfoInstances(),
    isEnriched: (appid: number) => enrichedAppIds.has(appid),
};

/** The Steam match each shortcut last rendered with (guardrail 11 refresh on change). */
const nativeByAppid = new Map<number, number>();

export function createGameInfoSurface(
    d: SurfaceDeps & {
        metadataOf(appid: number): GameMetadata | undefined;
    },
): Surface {
    deps.isEnabled = d.isEnabled;
    deps.reportError = d.reportError;
    deps.metadataOf = d.metadataOf;
    return {
        id: "game-info",
        touches: [
            "GameInfo.k.render",
            "GameInfo.k.props",
            "GameInfo.G.render",
            "GameInfo.G.props",
            // a second, independent listener on the method library-home also patches: named apart so the touches stay disjoint
            "collectionStore.OnAppOverviewChange#game-info-repair",
            "AppOverview.GetGameID",
            "AppOverview.BHasStoreCategory",
            "AppOverview.rt_original_release_date",
            "AppOverview.m_setStoreCategories",
            "AppDetailsStore.descriptionsData",
            "AppDetailsStore.associationData",
            // part `playbar` (its own kill switch; was a surface of its own until M10)
            "PlayBar.render",
            "PlayBar.props",
        ],
        reads: ["identity", "metadata"],
        install() {
            // Cache SharedJSContext singletons for stores before portals render
            setCachedStores((window as any).appDetailsStore, (window as any).appStore);
            // Bypass Big Picture native shortcut filter on Game Info tab
            patchGameInfoComponent();
            installOverviewRepair();
            // The desktop PlayBar's ⓘ button: its own switch, so its failure never takes Game Info down.
            if (deps.isEnabled("playbar")) {
                try {
                    patchPlayBar();
                } catch (err) {
                    deps.reportError("playbar", err);
                }
            }
        },
        render(appid, record) {
            // Guardrail 11: Game Info already rendered with the shortcut's own appid before the Steam
            // match resolved; a new match re-renders every window (was app/steam-store's job before M10).
            const native = record?.identity?.data?.native?.appid;
            if (native !== nativeByAppid.get(appid)) {
                if (native === undefined) nativeByAppid.delete(appid);
                else {
                    nativeByAppid.set(appid, native);
                    refreshGameInfoInstances();
                }
            }
            const metadata = record?.metadata;
            if (metadata?.status === "ok" || (metadata?.status === "error" && metadata.data)) {
                enrichGameDetails(appid, metadata.data!);
            } else if (isAppEnriched(appid)) {
                revertGameDetails(appid);
            }
        },
        clear: (appid) => {
            nativeByAppid.delete(appid);
            revertGameDetails(appid);
        },
        uninstall() {
            /* the patches stay until Steam restarts, as before M3.3 */
        },
    };
}
