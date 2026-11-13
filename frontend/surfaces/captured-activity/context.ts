// What every file of this surface gets from createCapturedActivitySurface: steam-cartridges' kill switch and error budget
// for the surface (one id, `captured-activity`), behind the per-part calls the files make. Open until the surface is created.
import type { SurfaceDeps } from "../../kernel/surface";

export type PartId = "feed" | "store-stub" | "headline" | "cards" | "bpm-style";

let deps: SurfaceDeps = { isEnabled: () => true, reportError: () => {} };

export function setDeps(d: SurfaceDeps): void {
    deps = d;
}

export const safety = {
    isEnabled: (_part: PartId): boolean => deps.isEnabled("captured-activity"),
    reportError: (part: PartId, err: unknown): void => deps.reportError("captured-activity", Object.assign(err instanceof Error ? err : new Error(String(err)), { part })),
};
