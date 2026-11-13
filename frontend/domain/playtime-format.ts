// domain/playtime-format: the hours a player types and reads in the Playtime block (pure; tests load it with node).

/** Minutes as hours with at most one decimal ("12.5", "0", "1"). */
export function formatHours(minutes: number): string {
    const h = Math.round((Math.max(0, minutes) / 60) * 10) / 10;
    return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** Typed hours ("12.5", "12,5", " 3 ") to whole minutes; undefined for anything else (negative, text, empty). */
export function parseHours(text: string): number | undefined {
    const t = text.trim().replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
    const h = Number(t);
    return Number.isFinite(h) && h >= 0 && h < 1_000_000 ? Math.round(h * 60) : undefined;
}
