// The scoped AppOverview proxy (guardrail 1): hands one component an overview whose
// BIsModOrShortcut() is false, without touching AppOverview.prototype. Moved from
// game-info in M3.4 so the two surfaces that need it share one copy.
// ONLY surfaces/game-info and surfaces/playbar may import this (tests/architecture.test.ts).

export function createPatchedOverview(overview: any): any {
    if (!overview) return overview;
    if (overview.__nsga_is_patched_proxy) return overview;
    return new Proxy(overview, {
        get(target, prop, receiver) {
            if (prop === "__nsga_is_patched_proxy") return true;
            if (prop === "BIsModOrShortcut") {
                return () => false;
            }
            if (prop === "GetGameID") {
                return () =>
                    target.m_gameid ||
                    (typeof target.GetGameID === "function"
                        ? target.GetGameID()
                        : target.appid?.toString());
            }
            if (prop === "gameid") {
                return target.m_gameid || target.gameid;
            }
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === "function") {
                return val.bind(target);
            }
            return val;
        },
    });
}
