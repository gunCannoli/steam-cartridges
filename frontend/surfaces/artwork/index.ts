// Surface `artwork` (migration plan M3.9, record-driven since M5c, ADR-0039): the only code that
// writes a shortcut's custom artwork slots, logo position and library icon. No hooks. `render(appid,
// record)` executes the plan app/artwork.ts put in `record.artwork` (which slots to clear, which to
// write, the icon file to point at), with the bytes app/artwork put in the image bin; it never decides
// what art a game gets and never does I/O (M10). What it wrote goes out as `artwork.applied`.
import type { ShortcutId } from "../../kernel/appid";
import type { ArtworkPlan } from "../../kernel/record";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { union } from "../../kernel/lists";
import { applyCustomArtwork } from "./artwork";
import { deps } from "./deps";
import { applyIcon } from "./icon";
import { clearLogoPosition, ensureLogoPosition } from "./logo";

/** Clear one slot this plugin wrote. Called on the object: never extract the method. */
async function clearSlot(appid: number, slot: number): Promise<void> {
    if (!deps.isEnabled("artwork")) return;
    const apps = (window as any).SteamClient?.Apps;
    await apps?.ClearCustomArtworkForApp?.(appid, slot);
}


async function execute(appid: ShortcutId, plan: ArtworkPlan): Promise<void> {
    if (!deps.isEnabled("artwork")) return;

    for (const slot of plan.clear) {
        try {
            await clearSlot(appid, slot);
        } catch {}
    }
    if (plan.clear.includes(2)) await clearLogoPosition(appid);

    const written = plan.write.length > 0 ? await applyCustomArtwork(appid, plan.write, deps.images.get(appid)) : [];
    // Parity E: our logo needs a position or Steam never draws it.
    if (union(plan.kept, written).includes(2)) await ensureLogoPosition(appid);
    // Icon plan: the library icon (ours, or a Clear's restore) comes after the slots.
    const iconSet = plan.icon ? await applyIcon(appid, plan.icon) : false;

    if (plan.source === "cleared" || (plan.write.length === 0 && !iconSet)) return;
    deps.bus.emit("artwork.applied", {
        appid,
        source: plan.source,
        steamAppid: plan.steamAppid,
        attempted: plan.write,
        kept: plan.kept,
        tried: plan.tried,
        written,
        ...(iconSet && plan.icon && "path" in plan.icon ? { icon: { path: plan.icon.path, previous: plan.icon.previous } } : {}),
    });
}

/** One plan at a time per shortcut (a Clear followed by a write must not interleave). */
const queues = new Map<number, Promise<void>>();

export function createArtworkSurface(d: SurfaceDeps & Pick<typeof deps, "images" | "bus">): Surface {
    deps.isEnabled = d.isEnabled;
    deps.reportError = d.reportError;
    deps.images = d.images;
    deps.bus = d.bus;
    return {
        id: "artwork",
        touches: [
            "SteamClient.Apps.SetCustomArtworkForApp",
            "SteamClient.Apps.ClearCustomArtworkForApp",
            "AppDetailsStore.SaveCustomLogoPosition",
            "AppDetailsStore.ClearCustomLogoPosition",
            "SteamClient.Apps.SetShortcutIcon",
        ],
        reads: ["artwork"],
        install() {},
        render(appid, record) {
            const part = record?.artwork;
            if (part?.status !== "ok" || !part.data) return;
            const plan = part.data;
            const next = (queues.get(appid) ?? Promise.resolve())
                .then(() => execute(appid, plan))
                .catch((err) => deps.reportError("artwork", err));
            queues.set(appid, next);
        },
        clear() {},
        uninstall() {},
    };
}
