// Kernel: the one place appids are normalized (migration plan M1, ADR-0039).
// Steam's CEF hands shortcut appids to JS as signed int32 (3858889198 arrives as
// -436078098; knowledgebase.md "Signed vs Unsigned 32-bit AppId in CEF"). Every map in
// the plugin is keyed by ShortcutId, which only toShortcutId() creates.

/** An unsigned 32-bit non-Steam shortcut appid. Create with toShortcutId() only. */
export type ShortcutId = number & { readonly __brand: "ShortcutId" };

/** Steam assigns non-Steam shortcuts appids at the top of the 32-bit range. */
export const NON_STEAM_APPID_MIN = 0x8000_0000;

/** The unsigned form of any appid Steam hands us (signed or unsigned, number or string). */
export function toUnsigned(raw: unknown): number | undefined {
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) return undefined;
    if (n < -0x8000_0000 || n > 0xffff_ffff) return undefined;
    return n >>> 0;
}

/** A ShortcutId for a non-Steam shortcut appid, or undefined for anything else (native apps too). */
export function toShortcutId(raw: unknown): ShortcutId | undefined {
    const u = toUnsigned(raw);
    return u !== undefined && u >= NON_STEAM_APPID_MIN ? (u as ShortcutId) : undefined;
}

/** True for a non-Steam shortcut appid in either signed or unsigned form. */
export function isShortcutAppId(raw: unknown): boolean {
    return toShortcutId(raw) !== undefined;
}

/** The signed int32 form, for the few Steam APIs that key by it. */
export function toSignedKey(id: ShortcutId): number {
    return id | 0;
}

/** The 64-bit gameid Steam files captures under: (appid << 32) | 0x02000000, as a decimal string. */
export function toGameId(id: ShortcutId): string {
    return ((BigInt(id) << 32n) | 0x0200_0000n).toString();
}

/** The shortcut appid inside a 64-bit shortcut gameid, or undefined if it is not one. */
export function fromGameId(gameid: string): ShortcutId | undefined {
    if (!/^\d+$/.test(gameid)) return undefined;
    const g = BigInt(gameid);
    if ((g & 0xffff_ffffn) !== 0x0200_0000n) return undefined;
    return toShortcutId(Number(g >> 32n));
}

/**
 * The keys a shortcut may be stored under in a JSON map that older code wrote (settings, backend files):
 * unsigned first, then signed. For reading persisted maps only; our own in-memory maps use one
 * unsigned key (toUnsigned). The one place the two-key read lives (M10).
 */
export function storedKeys(raw: unknown): string[] {
    const u = toUnsigned(raw);
    if (u === undefined) return [];
    const signed = u | 0;
    return signed === u ? [String(u)] : [String(u), String(signed)];
}

/** The value a persisted map holds for this appid under either key (storedKeys), or undefined. */
export function lookupStored<T>(map: Record<string, T> | undefined, raw: unknown): T | undefined {
    for (const key of storedKeys(raw)) {
        const value = map?.[key];
        if (value !== undefined) return value;
    }
    return undefined;
}
