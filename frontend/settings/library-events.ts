// A change to what the plugin holds about the library (Delete metadata): the sections that show counts read again (Library Analytics, the
// Library Setup block). Settings-only, no imports.
const listeners = new Set<() => void>();

/** Called by whatever changed the stored data. */
export function libraryChanged(): void {
    for (const fn of listeners) {
        try {
            fn();
        } catch {
            /* one section's refresh never stops the others */
        }
    }
}

/** A section's subscription; returns its unsubscribe. */
export function onLibraryChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
