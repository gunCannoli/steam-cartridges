// app/identity: resolves whether a shortcut has a native Steam match, through
// one EnsureFresh call instead of up to three round trips (migration plan M4c).
import { logger } from "../logger.ts";
import type { ShortcutId } from "../kernel/appid";
import type { Identity, OwnedCandidate, Part, RecordStore, Route } from "../kernel/record";
import type { backend as Backend } from "../ports/backend";
import { createSessionMemo } from "./session-memo.ts";

export interface IdentityDeps {
    backend: Pick<typeof Backend, "ensureFresh">;
    records: RecordStore;
    owned(): OwnedCandidate[];
    titleOf(appid: number): string | undefined;
}

export interface IdentityResolver {
    ensure(appid: ShortcutId, route: Route): Promise<Part<Identity>>;
    invalidate(appid: ShortcutId): void;
}

export function createIdentity(deps: IdentityDeps): IdentityResolver {
    /** One resolution per appid per session (app/session-memo.ts); only ok and unsupported are final. */
    const memo = createSessionMemo<Identity>();

    async function resolve(appid: ShortcutId, route: Route): Promise<Part<Identity>> {
        if (route.bucket !== "steam-store") {
            const part: Part<Identity> = { status: "unsupported" };
            deps.records.update(appid, { identity: part });
            return part;
        }

        const title = deps.titleOf(appid) ?? "";
        // The page waits for it: the view lane (ADR-0060).
        const res = await deps.backend.ensureFresh(appid, ["identity"], {
            title,
            route,
            owned: deps.owned(),
        }, { lane: "view" });

        const raw = res.error ? undefined : (res.parts.identity as Part<Identity> | undefined);
        const part: Part<Identity> = raw ?? { status: "error", message: res.error ?? "no identity part" };

        logger.info(`Identity ${appid}: ${part.status} ${part.data?.native ? part.data.native.appid : "-"}`);
        deps.records.update(appid, { identity: part });
        return part;
    }

    return {
        async ensure(appid, route) {
            // Not a steam-store route: unsupported for this route only, never remembered (a bucket may change).
            if (route.bucket !== "steam-store") return resolve(appid, route);
            return memo.run(appid, () => resolve(appid, route), () => deps.records.get(appid)?.identity);
        },
        invalidate(appid) {
            memo.forget(appid);
        },
    };
}
