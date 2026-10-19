// Surface `toasts`: what the composition root gives it (migration plan M3.6, § 7.0 D6).
import type { SurfaceDeps } from "../../kernel/surface";

export const deps: SurfaceDeps = { isEnabled: () => true, reportError: () => {} };
