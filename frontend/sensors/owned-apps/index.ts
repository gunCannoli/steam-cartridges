// Sensor `owned-apps` (migration plan M4c, ADR-0039): native games Steam
// already knows, for the resolver's context. Moved verbatim from
// features/steam-store/known-apps.ts `readNativeGames`.

import { NON_STEAM_APPID_MIN } from "../../kernel/appid";
import type { OwnedCandidate } from "../../kernel/record";

/** Steam's app_type for a game (P0 T3: 309 of 470 native entries here). */
const APP_TYPE_GAME = 1;

/** Native games Steam already knows (owned/known; not the whole store). Zero network. */
export function ownedCandidates(): OwnedCandidate[] {
    const all: any[] = (window as any).appStore?.allApps ?? [];
    return all
        .filter((a) => a && a.appid > 0 && a.appid < NON_STEAM_APPID_MIN && a.app_type === APP_TYPE_GAME && a.display_name)
        .map((a) => ({ appid: a.appid as number, name: String(a.display_name) }));
}
