// Surface `artwork` (migration plan M3.9): writes custom artwork slots through SteamClient.Apps.
// Moved from features/artwork/artwork.ts. M10: the bytes come from the image bin (app/artwork fetched
// them); nothing here fetches.
import { logger } from "../../logger";
import { SLOT_KEYS, type BinImages } from "../../kernel/image-bin";
import { deps } from "./deps";

/**
 * Steam custom artwork slot types:
 * 0: Portrait Capsule (600x900)
 * 1: Hero Banner (1920x620)
 * 2: Transparent Logo PNG
 * 3: Wide Capsule (920x430)
 */
export const ARTWORK_TYPES = {
    PORTRAIT: 0,
    HERO: 1,
    LOGO: 2,
    WIDE: 3,
} as const;

/** Write the plan's slots from the bin; returns the slots Steam accepted. A slot with no bytes is skipped (reported failed). */
export async function applyCustomArtwork(appid: number, slots: readonly number[], images: BinImages): Promise<number[]> {
    if (!deps.isEnabled("artwork")) return [];
    const sc = (window as any).SteamClient;
    if (!sc?.Apps?.SetCustomArtworkForApp) {
        logger.warn("SteamClient.Apps.SetCustomArtworkForApp is not available.");
        return [];
    }

    const appliedSlots: number[] = [];
    for (const slot of slots) {
        const label = SLOT_KEYS[slot];
        const asset = label ? images[label] : undefined;
        if (!label || !asset) continue; // not fetched: reported as failed, retried once per session
        try {
            if (typeof sc.Apps.ClearCustomArtworkForApp === "function") {
                try {
                    await sc.Apps.ClearCustomArtworkForApp(appid, slot);
                } catch {}
                await new Promise((r) => setTimeout(r, 100));
            }
            await sc.Apps.SetCustomArtworkForApp(appid, asset.base64, asset.ext, slot);
            appliedSlots.push(slot);
            logger.info(`Set custom ${label} artwork for appid ${appid}`);
        } catch (err) {
            logger.warn(`Failed to set ${label} artwork for appid ${appid}:`, err);
        }
    }
    return appliedSlots;
}
