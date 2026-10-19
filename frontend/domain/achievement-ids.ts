// domain/achievement-ids: map a token an extension or a file reports to the schema's id (ADR-0063). Pure.
// Order: exact id, id ignoring case, `ach_` prefix added or removed, display name ignoring case, then letters and digits only.

export interface NamedAchievement {
    id: string;
    name: string;
}

const alnum = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function canonicalAchievementId(token: unknown, schema: readonly NamedAchievement[]): string | undefined {
    if (typeof token !== "string" && typeof token !== "number") return undefined;
    const t = String(token).trim();
    if (!t || !Array.isArray(schema) || schema.length === 0) return undefined;
    const lower = t.toLowerCase();
    for (const a of schema) if (a.id === t) return a.id;
    for (const a of schema) if (a.id.toLowerCase() === lower) return a.id;
    const swapped = lower.startsWith("ach_") ? lower.slice(4) : `ach_${lower}`;
    for (const a of schema) if (a.id.toLowerCase() === swapped) return a.id;
    for (const a of schema) if ((a.name ?? "").trim().toLowerCase() === lower) return a.id;
    const key = alnum(t);
    if (!key) return undefined;
    for (const a of schema) if (alnum(a.id) === key || alnum(a.name ?? "") === key) return a.id;
    return undefined;
}
