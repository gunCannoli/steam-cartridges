// Surface `properties` (ADR-0080): a "Cartridge" page in a
// non-Steam game's Properties dialog: the game's editable data, in the dialog itself (the Game Data editor's form).
//
// Steam builds the dialog's page list on every render (`pages = []`, then `push({ title, route, link, content })`) and
// passes it as `jsx(Sidebar, { pages, ... })` (docs/steam-components.md, "The Properties dialog's page list"). The jsx
// hook recognises that call by the SHAPE of its props, never by a module id, and swaps the element type for a wrapper
// (one per original type, cached, so React never remounts the dialog) that renders it with our entry appended. Only the
// shortcut dialog is touched (its first page is `/app/:appid/properties/shortcut`); a Steam game's stays Steam's.
//
// The page body is a component handed in by index.tsx (settings/game-editor/game-form.tsx CartridgeBody: the editor's
// form for this game, so the data is edited right there). This surface only places it: it imports nothing of settings/,
// the app or the backend, and no other layer reads it.
import { createElement, type ComponentType } from "react";
import type { Surface, SurfaceDeps } from "../../kernel/surface";
import { keepJsxPatched } from "../../steam/jsx-hook";
import { jsxRuntime } from "../../steam/modules";
import { appidOfLink, CARTRIDGE_ROUTE, shortcutPages, type PageEntry } from "./core";

export interface PropertiesDeps extends SurfaceDeps {
    /** The page body for a game (an opaque component; the surface never knows what it does). */
    body: ComponentType<{ appid: number }>;
}

const ID = "properties";

let deps: PropertiesDeps = {
    isEnabled: () => true,
    reportError: () => {},
    body: () => null,
};
let hook: ReturnType<typeof keepJsxPatched> | undefined;
/** One wrapper per Steam element type, so the element's identity is stable across renders. */
const wrappers = new WeakMap<object, ComponentType<{ pages: PageEntry[] }>>();
let added = 0;

/** The wrapper that renders Steam's own sidebar with the Cartridge page added. */
function wrapperFor(type: object): ComponentType<{ pages: PageEntry[] }> {
    let wrapper = wrappers.get(type);
    if (!wrapper) {
        const original = type as unknown as ComponentType<{ pages: PageEntry[] }>;
        wrapper = function CartridgeSidebar(props: { pages: PageEntry[] }) {
            try {
                const appid = appidOfLink(props.pages[0]?.link ?? "");
                if (appid !== undefined && deps.isEnabled(ID) && shortcutPages(props)) {
                    const page: PageEntry = {
                        title: "Cartridge",
                        route: CARTRIDGE_ROUTE,
                        link: `/app/${props.pages[0]!.link.split("/")[2]}/properties/cartridge`,
                        content: createElement("div", { className: "DialogBody" }, createElement(deps.body, { appid })),
                    };
                    added++;
                    return createElement(original, { ...props, pages: [...props.pages, page] });
                }
            } catch (err) {
                deps.reportError(ID, err);
            }
            return createElement(original, props);
        };
        wrappers.set(type, wrapper);
    }
    return wrapper;
}

function replaceType(type: unknown, props: unknown): unknown {
    // Cheapest test first: nearly every element has no `pages` prop.
    if (!props || typeof props !== "object" || !("pages" in props)) return undefined;
    try {
        if (!deps.isEnabled(ID) || (typeof type !== "function" && (typeof type !== "object" || type === null))) return undefined;
        if (!shortcutPages(props)) return undefined;
        return wrapperFor(type as object);
    } catch (err) {
        deps.reportError(ID, err);
        return undefined;
    }
}

function install(): void {
    const runtime = jsxRuntime();
    if (!runtime) return;
    hook = keepJsxPatched(runtime as unknown as Record<"jsx" | "jsxs", (type: unknown, props: unknown, key?: unknown) => unknown>, {
        label: ID,
        replaceType,
    });
}

/** For CDP and tests: how often the page was added. */
export function propertiesDiagnostics(): { installed: boolean; added: number } {
    return { installed: !!hook, added };
}

export function createPropertiesSurface(d: PropertiesDeps): Surface {
    deps = d;
    return {
        id: ID,
        touches: ["jsx:properties-cartridge"],
        reads: [],
        install,
        render() {},
        clear() {},
        uninstall() {
            hook?.dispose();
            hook = undefined;
        },
    };
}
