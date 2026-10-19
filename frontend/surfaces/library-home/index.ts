// Surface `library-home` (migration plan M3.10, ADR-0039): fills in the library grid's
// "last played" fields of shortcuts from capture timestamps, through
// collectionStore.OnAppOverviewChange. The stats come from app/library-stats (M10: this surface calls
// no backend). Registration is async (it waits for the store); install() starts it and ready() lets
// index.tsx keep its start-up order.
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { deps, register } from "./grid";

export { refresh } from "./grid";

let registration: Promise<unknown> = Promise.resolve();

/** Resolves when the grid patch is registered (or failed); never rejects. */
export function ready(): Promise<void> {
    return registration.then(
        () => undefined,
        () => undefined,
    );
}

export function createLibraryHomeSurface(d: SurfaceDeps & Pick<typeof deps, "stats">): Surface {
    deps.isEnabled = d.isEnabled;
    deps.reportError = d.reportError;
    deps.stats = d.stats;
    return {
        id: "library-home",
        touches: [
            "collectionStore.OnAppOverviewChange",
            "AppOverview.rt_recent_activity_time",
            "AppOverview.rt_last_time_played_or_installed",
        ],
        reads: [],
        install() {
            registration = register().catch((err) => deps.reportError("library-home", err));
        },
        render() {
            /* not record-driven: capture stats are Steam's own data (ADR-0022), read from app/library-stats (M10) */
        },
        clear() {},
        uninstall() {
            /* the patch stays until Steam restarts, as before M3.10 */
        },
    };
}
