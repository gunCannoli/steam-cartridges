// Surface `captures` (migration plan M3.2, ADR-0039): the only code that writes Steam's
// spotlight, activity and StoreItemCache stores, from Steam's own captures (ADR-0022) and the
// record. Takes over the kill switches `captures` and `store-cache` (plan § 7.0 D6). The
// captures in the Activity feed (the "{Username} captured" cards) are the separate
// steam-captured-activity plugin's (docs/steam-captured-activity.md).
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { ensureStoreCacheHooked, setAchievementSource, setNativeActivitySource } from "./activity";
import { deps } from "./deps";
import { onRecordChanged, unpatch } from "./publish";

export { patch, refresh, unpatch } from "./publish";
export { setNativeActivitySource } from "./activity";
export { addSessionAchievement, onSynced, onUnlocked } from "./session";
export { registerSummaryProvider } from "./summary";
export type { SummaryContext, SummaryContribution, SummaryProvider } from "./summary";

/** Install one part under its own kill switch; a failure counts against that switch only. */
function part(id: string, install: () => unknown): void {
    if (!deps.isEnabled(id)) return;
    try {
        install();
    } catch (err) {
        deps.reportError(id, err);
    }
}

export function createCapturesSurface(d: SurfaceDeps & Pick<typeof deps, "activityOptions" | "bus">): Surface {
    deps.isEnabled = d.isEnabled;
    deps.reportError = d.reportError;
    deps.activityOptions = d.activityOptions;
    deps.bus = d.bus;
    return {
        id: "captures",
        touches: [
            "AppSpotlightStore.GetOrCreateAppData",
            "AppSpotlightStore.m_session.AddAchievement",
            "AppActivityStore.m_mapAppActivity",
            "StoreItemCache.m_mapApps",
            "StoreItemCache.m_setUnavailableApps",
            "StoreItemCache.BIsAppMissing",
        ],
        reads: ["identity", "achievements"],
        install() {
            part("store-cache", ensureStoreCacheHooked);
        },
        render(appid, record) {
            // Captures are Steam's own data, read live (ADR-0022); the native activity source (a mapped shortcut's
            // Steam Store match) and the unlocks (ADR-0056) are record-driven.
            setNativeActivitySource(appid, record?.identity?.data?.native?.appid);
            const ach = record?.achievements;
            setAchievementSource(appid, ach?.status === "ok" ? ach.data : undefined);
            // Only an open page: a render for every shortcut at start-up flooded Steam's recording service (publish.ts).
            onRecordChanged(appid);
        },
        clear: (appid) => unpatch(appid),
        uninstall() {
            /* the patches stay until Steam restarts, as before M3.2 */
        },
    };
}
