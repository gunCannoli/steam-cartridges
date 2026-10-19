// app/provided: what extensions push about a shortcut (ADR-0067; Epic and Xbox copies from steam-cartridges-third-party).
// `reportGame` keeps a game's Game Info and media in the backend (provided_store) and the record's `provided` part; the
// backend's metadata and media services then use it as one more source, so a changed push refreshes those two parts.
// `forgetGame` drops it. The core never asks a store: everything here is what an extension found.
import { logger } from "../logger.ts";
import { toShortcutId, type ShortcutId } from "../kernel/appid.ts";
import type { ProvidedGameReport, ReportOptions } from "../kernel/extensions.ts";
import type { Part, ProvidedGame, RecordStore } from "../kernel/record";
import type { backend as Backend } from "../ports/backend";

export interface ProvidedDeps {
    backend: Pick<typeof Backend, "provideGame" | "forgetProvidedGame" | "getAllRecords">;
    records: RecordStore;
    /** Creates the base record if the appid has none yet (app/records.ts ensureBase). */
    ensureBase(appid: ShortcutId): void;
    /** Re-read Game Info and community media for a shortcut whose pushed data changed (index.tsx: app/metadata, app/media). */
    refresh(appid: ShortcutId): void;
}

export interface ProvidedService {
    reportGame(appid: number, game: ProvidedGameReport, opts: ReportOptions): Promise<{ ok: boolean; changed?: boolean }>;
    forgetGame(appid: number, opts: ReportOptions): Promise<{ ok: boolean }>;
    /** Start-up: every pushed record's `provided` part into its record (disk only), so app/achievements knows them. */
    preload(): Promise<number>;
}

export function createProvided(deps: ProvidedDeps): ProvidedService {
    return {
        async reportGame(appid, game, opts) {
            const id = toShortcutId(Number(appid));
            if (id === undefined || !game || typeof game.source !== "string" || game.source === "") return { ok: false };
            const res = await deps.backend.provideGame(id, {
                source: game.source,
                provider: opts?.providerId ?? game.source,
                title: game.title,
                metadata: game.metadata,
                media: game.media,
            }, { lane: "background" });
            if (!res || res.error || !res.ok) {
                if (res?.error) logger.warn(`${opts?.providerId ?? game.source}: the game for shortcut ${id} was not kept: ${res.error}`);
                return { ok: false };
            }
            deps.ensureBase(id);
            const part: Part<ProvidedGame> = { status: "ok", source: game.source, data: { source: game.source, title: game.title, provider: opts?.providerId } };
            deps.records.update(id, { provided: part });
            if (res.changed) {
                logger.info(`${opts?.providerId ?? game.source} reported shortcut ${id} as a ${game.source} game.`);
                deps.refresh(id);
            }
            return { ok: true, changed: res.changed === true };
        },
        async forgetGame(appid, opts) {
            const id = toShortcutId(Number(appid));
            if (id === undefined) return { ok: false };
            const res = await deps.backend.forgetProvidedGame(id, { lane: "background" });
            if (!res || res.error) return { ok: false };
            if (deps.records.get(id)?.provided?.status === "ok") {
                deps.records.update(id, { provided: { status: "unsupported" } });
                logger.info(`${opts?.providerId ?? "an extension"} no longer reports shortcut ${id}.`);
            }
            return { ok: true };
        },
        async preload() {
            const res = await deps.backend.getAllRecords().catch(() => undefined);
            let n = 0;
            for (const [key, parts] of Object.entries(res?.records ?? {})) {
                const id = toShortcutId(Number(key));
                const part = (parts as { provided?: Part<ProvidedGame> })?.provided;
                if (id === undefined || part?.status !== "ok") continue;
                deps.ensureBase(id);
                deps.records.update(id, { provided: part });
                n++;
            }
            return n;
        },
    };
}
