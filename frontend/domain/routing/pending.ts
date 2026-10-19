/** Collection-dependent resolution is deferred (`pending`) until the store is ready. */
export function pendingOr<T>(needsCollections: boolean, ready: boolean, resolve: () => T): T | { bucket: 'none'; via: 'pending' } {
    if (needsCollections && !ready) return { bucket: 'none', via: 'pending' };
    return resolve();
}
