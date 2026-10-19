// Surface `artwork`: what the composition root gives it (migration plan M3.9, § 7.0 D6; M10: no backend calls).
import type { EventBus } from "../../kernel/events";
import type { ImageBin } from "../../kernel/image-bin";
import type { SurfaceDeps } from "../../kernel/surface";

export const deps: SurfaceDeps & {
    /** The slot bytes app/artwork fetched (kernel/image-bin); read only. */
    images: Pick<ImageBin, "get">;
    /** Where the surface reports what it wrote (`artwork.applied`; app/artwork records it). */
    bus: Pick<EventBus, "emit">;
} = {
    isEnabled: () => true,
    reportError: () => {},
    images: { get: () => ({}) },
    bus: { emit: () => {} },
};
