// kernel/lists: pure helpers for the list shapes that cross the backend and the artwork plans (one copy, D1).

/** K1: Millennium's cjson encodes an empty Lua table as `{}`; accept an array or an object of items. */
export function asList<T>(v: unknown): T[] {
    if (Array.isArray(v)) return v as T[];
    if (v && typeof v === "object") return Object.values(v as Record<string, T>);
    return [];
}

/** The sorted union of two slot lists. */
export function union(a: readonly number[], b: readonly number[]): number[] {
    return [...new Set([...a, ...b])].sort((x, y) => x - y);
}
