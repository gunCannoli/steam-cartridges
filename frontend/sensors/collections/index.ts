// Collections sensor (migration plan M2, ADR-0039): the only code that reads Steam's
// collectionStore for membership (guardrail 13). No runtime imports, so
// tests/buckets-ready.test.ts can load it with node.

/** Plain-field read, no MobX side effects. Steam creates m_mapCollectionsFromStorage on its first
 *  cloud-storage callback; before that, reading userCollections / uncategorizedCollection throws
 *  inside a keepAlive computed and poisons it for the session (see plan). */
export function isCollectionStoreReady(store: any): boolean {
    const m = store?.m_mapCollectionsFromStorage;
    return !!m && typeof m.values === 'function';
}
/** userCollections only when ready; never throws. */
export function readUserCollections(store: any): any[] | undefined {
    if (!isCollectionStoreReady(store)) return undefined;
    try {
        const list = store.userCollections;
        return Array.isArray(list) ? list : undefined;
    } catch {
        return undefined;
    }
}

/** What features/buckets reads membership from (wired in index.tsx). */
export const collectionsSource = {
    ready: (): boolean => isCollectionStoreReady((window as any).collectionStore),
    list: (): any[] | undefined => readUserCollections((window as any).collectionStore),
};
