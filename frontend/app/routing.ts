import {
    findConflicts,
    resolveBucket,
    isServiceAllowed,
    isMediaServiceAllowed,
    type AutoRoutingProfile,
    type Bucket,
    type BucketsConfig,
    type Resolution,
    type RoutingRule,
    type ServiceTarget,
} from '../domain/routing/policy.ts';
import { pendingOr } from '../domain/routing/pending.ts';
import { NON_STEAM_APPID_MIN, toUnsigned } from '../kernel/appid.ts';

export interface CollectionInfo {
    id: string;
    name: string;
    dynamic: boolean;
    shortcutCount: number;
}

export interface BucketReport {
    collections: (CollectionInfo & { bucket: Bucket })[];
    conflicts: { appid: number; name: string; collectionIds: string[]; buckets: Bucket[]; using: Bucket }[];
    missing: { id: string; name: string; bucket: Bucket; relinkId?: string }[];
    unbucketedWithMetadata: number;
    ready: boolean;
    games: Record<number, { bucket: Bucket; via: Resolution['via'] }>;
}

export interface RoutingInputs {
    buckets(): BucketsConfig;
    autoMode(): boolean;
    /** Setting routingRules (service rules, ADR-0040). */
    rules(): RoutingRule[];
    collections: { ready(): boolean; list(): any[] | undefined };
    titleOf(appid: number): string | undefined;
    shortcuts(): { appid: number; name: string }[];
    loadProfiles(): Promise<Record<string, AutoRoutingProfile>>;
    metadataAppids(): Iterable<number>;
}

const TTL_MS = 2000;

/**
 * Stateful routing: settings + live collections, wrapped around the pure
 * policy in domain/routing (migration plan M4a, ADR-0040).
 */
export function createRouting(inputs: RoutingInputs) {
    const profiles = new Map<number, AutoRoutingProfile>();
    const membershipCache = new Map<string, { at: number; set: ReadonlySet<number> }>();

    function membersOf(id: string): ReadonlySet<number> | undefined {
        const list = inputs.collections.list();
        if (!list) return undefined;
        const now = Date.now();
        const hit = membershipCache.get(id);
        if (hit && now - hit.at < TTL_MS) return hit.set;
        const coll = list.find((c: any) => c?.id === id);
        if (!coll) {
            membershipCache.delete(id);
            return undefined;
        }
        const out = new Set<number>();
        const apps = coll?.apps;
        const keys: Iterable<unknown> = apps instanceof Map ? apps.keys() : Array.isArray(apps) ? apps.map((a: any) => a?.appid ?? a) : [];
        for (const k of keys) {
            const n = Number(k);
            if (Number.isFinite(n) && n >= NON_STEAM_APPID_MIN) out.add(n);
        }
        membershipCache.set(id, { at: now, set: out });
        return out;
    }

    function listCollections(): CollectionInfo[] {
        const list = inputs.collections.list();
        if (!list) return [];
        return list.map((c: any) => ({
            id: String(c.id),
            name: String(c.displayName ?? c.id),
            dynamic: !!c.bIsDynamic,
            shortcutCount: membersOf(String(c.id))?.size ?? 0,
        }));
    }

    async function waitForCollections(timeoutMs = 30_000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (inputs.collections.ready()) return inputs.collections.list() !== undefined;
            await new Promise((r) => setTimeout(r, 250));
        }
        return false;
    }

    async function loadAutoRoutingProfiles(): Promise<void> {
        const res = await inputs.loadProfiles();
        profiles.clear();
        for (const [key, value] of Object.entries(res ?? {})) {
            const appid = toUnsigned(key);
            if (appid !== undefined && value) profiles.set(appid, value);
        }
    }

    /** Start-up and ingest share one load (dataflow plan Phase 4); a failed load is tried again next time. */
    let profilesOnce: Promise<void> | undefined;
    function ensureProfiles(): Promise<void> {
        profilesOnce ??= loadAutoRoutingProfiles().catch((err) => {
            profilesOnce = undefined;
            throw err;
        });
        return profilesOnce;
    }

    function getAutoRoutingProfile(appid: number): AutoRoutingProfile | undefined {
        const key = toUnsigned(appid);
        return key === undefined ? undefined : profiles.get(key);
    }

    function listShortcuts(): { appid: number; name: string }[] {
        return [...inputs.shortcuts()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Resolutions are sticky for the session (ADR-0036) and dropped only when the
     * bucket settings change. Our own Game Info enrichment adds store categories,
     * which feed Steam's dynamic collections; without this a game could leave a
     * rule's collection because we enriched it, and flip bucket on the next view.
     * `pending` is never memoised.
     */
    const memo = new Map<number, Resolution>();

    function getBucket(appid: number): Resolution {
        const hit = memo.get(appid);
        if (hit) return hit;
        const cfg = inputs.buckets();
        const autoMode = inputs.autoMode();
        const autoProf = autoMode ? getAutoRoutingProfile(appid) : undefined;
        const r =
            appid >= NON_STEAM_APPID_MIN && cfg.overrides[String(appid)]
                ? resolveBucket(appid, cfg, membersOf, inputs.titleOf, autoProf)
                : (pendingOr<Resolution>(cfg.rules.length > 0, inputs.collections.ready(), () =>
                      resolveBucket(appid, cfg, membersOf, inputs.titleOf, autoProf),
                  ) as Resolution);
        if (r.via !== 'pending') memo.set(appid, r);
        return r;
    }

    function onBucketsChanged(fn: () => void): void {
        memo.clear();
        membershipCache.clear();
        fn();
    }

    function shortcutName(appid: number): string {
        return inputs.shortcuts().find((s) => s.appid === appid)?.name ?? String(appid);
    }

    function bucketReport(): BucketReport {
        const cfg = inputs.buckets();
        const ready = inputs.collections.ready();
        const live = listCollections();
        const liveIds = new Set(live.map((c) => c.id));
        const assigned = new Map(cfg.rules.map((a) => [a.id, a.bucket] as const));
        const shortcuts = listShortcuts();
        const appids = shortcuts.map((s) => s.appid);

        const games: BucketReport['games'] = {};
        for (const appid of appids) {
            const r = getBucket(appid);
            games[appid] = { bucket: r.bucket, via: r.via };
        }

        if (!ready) {
            return { ready, collections: [], conflicts: [], missing: [], unbucketedWithMetadata: 0, games };
        }
        return {
            ready,
            collections: live.map((c) => ({ ...c, bucket: assigned.get(c.id) ?? cfg.default })),
            conflicts: findConflicts(cfg, membersOf, appids, inputs.titleOf).map(({ appid, resolution }) => ({
                appid,
                name: shortcutName(appid),
                collectionIds: resolution.conflict!.collectionIds,
                buckets: resolution.conflict!.buckets,
                using: resolution.bucket,
            })),
            missing: cfg.rules
                .filter((a) => !liveIds.has(a.id))
                .map((a) => ({ id: a.id, name: a.name, bucket: a.bucket, relinkId: live.find((c) => c.name === a.name)?.id })),
            unbucketedWithMetadata: [...inputs.metadataAppids()].filter((id) => getBucket(id).bucket === 'none').length,
            games,
        };
    }

    /** The Community media sources' check: as `serviceAllowed`, but Auto Mode no longer keeps ScreenScraper off a PC game. */
    function mediaServiceAllowed(service: ServiceTarget, appid: number): boolean {
        const collNames = listCollections()
            .filter((c) => membersOf(c.id)?.has(appid))
            .map((c) => c.name);
        return isMediaServiceAllowed(
            service,
            appid,
            inputs.titleOf(appid) ?? "",
            collNames,
            inputs.rules(),
            inputs.autoMode(),
            getAutoRoutingProfile(appid),
        );
    }

    /** Do the routing rules and Auto Mode allow `service` for this shortcut? (was index.tsx and the audit panel) */
    function serviceAllowed(service: ServiceTarget, appid: number): boolean {
        const collNames = listCollections()
            .filter((c) => membersOf(c.id)?.has(appid))
            .map((c) => c.name);
        return isServiceAllowed(
            service,
            appid,
            inputs.titleOf(appid) ?? "",
            collNames,
            inputs.rules(),
            inputs.autoMode(),
            getAutoRoutingProfile(appid),
        );
    }

    return {
        getBucket,
        serviceAllowed,
        mediaServiceAllowed,
        onBucketsChanged,
        bucketReport,
        listCollections,
        membersOf,
        waitForCollections,
        loadAutoRoutingProfiles,
        ensureProfiles,
        getAutoRoutingProfile,
        listShortcuts,
    };
}

export type Routing = ReturnType<typeof createRouting>;
