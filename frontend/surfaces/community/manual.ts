// The manual's pages inside Steam's image viewer (features plan F2c, ADR-0048). Steam's viewer renders its `children`
// in a scrolling area under the Close button and scrolls it on the D-pad (module 94715, ArtworkModalContainer), so the
// pages are a plain column of images: controller and mouse-wheel scrolling come from Steam. The pages come from the
// manual shelf (kernel/manual-shelf), a pure read; the component re-renders when the shelf changes. When it mounts it
// reports that the viewer showed this manual (`community.manual-opened`, the surface's own result event); app/manuals
// does the rest. A render never starts work (guardrail 17): the report is sent from an effect.
import type { ManualView } from "../../kernel/manual-shelf";

type Jsx = (type: unknown, props: Record<string, unknown>, key?: string) => unknown;

export interface ManualPagesDeps {
    manualOf(appid: number, key: string): ManualView | undefined;
    subscribe(listener: () => void): () => void;
    /** Emit `community.manual-opened`. */
    opened(appid: number, key: string): void;
}

interface ReactHooks {
    useState<T>(initial: T): [T, (update: (previous: T) => T) => void];
    useEffect(effect: () => void | (() => void), deps: unknown[]): void;
}

const MESSAGE = { padding: "24px 0", textAlign: "center", opacity: 0.8, fontSize: 16 };
const COLUMN = { display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0 24px" };
const PAGE = { width: "100%", maxWidth: 1000, display: "block", borderRadius: 2 };

/** The page column component. `manualKey`, not `key`: React keeps `key` for itself. */
export function createManualPages(jsx: Jsx, deps: ManualPagesDeps): (props: { appid: number; manualKey: string }) => unknown {
    return function ManualPages(props) {
        const R = Reflect.get(globalThis, "SP_REACT") as ReactHooks | undefined;
        if (!R?.useState || !R.useEffect) return null;
        const [, setTick] = R.useState(0);
        R.useEffect(() => deps.subscribe(() => setTick((n) => n + 1)), []);
        R.useEffect(() => deps.opened(props.appid, props.manualKey), [props.appid, props.manualKey]);
        const view = deps.manualOf(props.appid, props.manualKey);
        if (view?.status === "failed") return jsx("div", { style: MESSAGE, children: "This manual could not be opened." });
        if (!view || view.pages.length === 0) return jsx("div", { style: MESSAGE, children: "Loading the manual..." });
        return jsx("div", {
            style: COLUMN,
            children: view.pages.map((page, i) =>
                page.url
                    ? jsx("img", { src: page.url, alt: `Page ${i + 1}`, style: { ...PAGE, aspectRatio: `${page.width} / ${page.height}` } }, String(i))
                    : jsx("div", { style: { ...PAGE, aspectRatio: `${page.width} / ${page.height}`, background: "rgba(255, 255, 255, 0.06)" } }, String(i)),
            ),
        });
    };
}
