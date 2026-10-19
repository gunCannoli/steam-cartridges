/**
 * Per-slot artwork bookkeeping for a steam-store game (P4 H5). Pure, `import
 * type` only, so Node can run the unit tests with type stripping.
 *
 *   nothing recorded                  -> write all four slots
 *   recorded for another native app   -> clear the slots we wrote, write all four
 *   recorded for this native app      -> retry only the slots that failed at write
 *                                        time, at most once per session
 *
 * A slot the user removed in Steam is pruned from `slots` by the backend and is
 * not in `failed`, so it is never written again (the user wins).
 */
import type { ArtworkPlan, ArtworkUrls, StoreApplied } from '../kernel/record';
import { union } from "../kernel/lists.ts";

export const ALL_SLOTS: readonly number[] = [0, 1, 2, 3];

/** Slot number -> ArtworkUrls key (SetCustomArtworkForApp image types). */
const SLOT_KEY: Record<number, keyof ArtworkUrls> = { 0: 'portrait', 1: 'hero', 2: 'logo', 3: 'wide' };

export interface ArtPlan {
    clear: number[];
    write: number[];
}

/** Lua's json.encode writes an empty list as `{}`; treat anything but an array as empty. */
export function slotList(v: unknown): number[] {
    return Array.isArray(v) ? v.filter((s): s is number => typeof s === 'number' && ALL_SLOTS.includes(s)) : [];
}

export function artworkPlan(applied: StoreApplied | null, steamAppid: number, retriedThisSession: boolean): ArtPlan {
    if (!applied) return { clear: [], write: [...ALL_SLOTS] };
    const slots = slotList(applied.slots);
    if (applied.steam_appid !== steamAppid) return { clear: slots, write: [...ALL_SLOTS] };
    if (retriedThisSession) return { clear: [], write: [] };
    return { clear: [], write: slotList(applied.failed).filter((s) => !slots.includes(s)) };
}

/** Only the URLs of the slots to write. */
export function pickUrls(urls: ArtworkUrls, slots: readonly number[]): ArtworkUrls {
    const out: ArtworkUrls = {};
    for (const slot of slots) {
        const key = SLOT_KEY[slot];
        if (key && urls[key]) out[key] = urls[key];
    }
    return out;
}

/** What to record after a write: kept + newly written slots, and the attempted slots that failed. */
export function mergeArtResult(
    applied: StoreApplied | null,
    steamAppid: number,
    plan: ArtPlan,
    written: readonly number[],
): { slots: number[]; failed: number[] } {
    const kept = applied && applied.steam_appid === steamAppid ? slotList(applied.slots) : [];
    const slots = [...new Set([...kept, ...written])].sort((a, b) => a - b);
    const failed = plan.write.filter((s) => !written.includes(s));
    return { slots, failed };
}

/**
 * SteamGridDB (M5c): a shortcut with no Steam match. Writes only the slots the backend
 * called empty (no grid file, never attempted) that also have a URL; clears nothing.
 * A slot the user set, or cleared after we filled it, is never touched.
 */
export function sgdbPlan(urls: ArtworkUrls, emptySlots: unknown): ArtPlan {
    const empty = slotList(emptySlots);
    return { clear: [], write: ALL_SLOTS.filter((s) => empty.includes(s) && !!urls[SLOT_KEY[s]!]) };
}

/**
 * The library icon (icon plan): written only when the backend called it eligible (Steam draws it
 * from the exe, or it is still ours) and there is a url. Anything but `true` is not eligible.
 */
export function iconPlan(urls: ArtworkUrls, eligible: unknown): { url: string; fallback?: string } | undefined {
    if (eligible !== true || typeof urls.icon !== 'string' || urls.icon === '') return undefined;
    const small = urls.iconSmall;
    return typeof small === 'string' && small !== '' && small !== urls.icon ? { url: urls.icon, fallback: small } : { url: urls.icon };
}

/** Clear's `icon_restore` (backend/steam_store_rpc.lua): the icon path to put back; anything but a string = none. */
export function iconRestoreOf(res: unknown): string | undefined {
    const v = res && typeof res === 'object' ? (res as { icon_restore?: unknown }).icon_restore : undefined;
    return typeof v === 'string' ? v : undefined;
}

/** The backend's `artwork` part data (backend/art_service.lua). */
export interface RawArtwork {
    urls: ArtworkUrls;
    source: 'steam-cdn' | 'steamgriddb';
    steamAppid?: number;
    applied?: StoreApplied | null;
    emptySlots?: unknown;
    /** The library icon may be set (icon plan; backend art_service.icon_eligible). */
    iconEligible?: unknown;
}

/**
 * The artwork plan for the backend's part (moved from app/artwork, M10): which slots to clear and write
 * from which URLs, and the icon URL to store when the icon is eligible (app/artwork stores it; the plan
 * gets its path).
 */
export function buildPlan(raw: RawArtwork, at: number): { plan: ArtworkPlan; iconUrl?: string; iconFallback?: string } {
    const applied = raw.applied && typeof raw.applied === 'object' ? raw.applied : null;
    const icon = iconPlan(raw.urls ?? {}, raw.iconEligible);
    const iconUrl = icon?.url;
    const iconFallback = icon?.fallback;
    if (raw.source === 'steam-cdn' && raw.steamAppid !== undefined) {
        const plan = artworkPlan(applied, raw.steamAppid, false);
        const kept = applied && applied.steam_appid === raw.steamAppid ? slotList(applied.slots) : [];
        return {
            plan: { source: 'steam-cdn', steamAppid: raw.steamAppid, urls: pickUrls(raw.urls, plan.write), write: plan.write, clear: plan.clear, tried: [], kept, at },
            iconUrl,
            iconFallback,
        };
    }
    const plan = sgdbPlan(raw.urls, raw.emptySlots);
    const ours = applied && applied.source === 'steamgriddb' ? applied : null;
    return {
        plan: {
            source: 'steamgriddb',
            urls: pickUrls(raw.urls, plan.write),
            write: plan.write,
            clear: [],
            tried: union(slotList(ours?.tried), plan.write),
            kept: slotList(ours?.slots),
            at,
        },
        iconUrl,
        iconFallback,
    };
}

/** What to record for the slots a plan wrote (P4 H5): SteamGridDB records the written slots (the backend
 *  unions with what it holds), the Steam CDN kept + written; failed = attempted - written. */
export function recordedSlots(source: 'steam-cdn' | 'steamgriddb', kept: number[], attempted: number[], written: number[]): { slots: number[]; failed: number[] } {
    return {
        slots: source === 'steamgriddb' ? [...written].sort((x, y) => x - y) : union(kept, written),
        failed: attempted.filter((s) => !written.includes(s)),
    };
}
