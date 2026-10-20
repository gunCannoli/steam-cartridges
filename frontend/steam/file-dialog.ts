/**
 * Steam's own file dialog, `SteamClient.System.OpenFileDialog` (verified live 2026-10-14 in enhanced-notifications:
 * Steam's "Choose icon" and "Add a Non-Steam Game" call it with `{ strTitle, rgFilters: [{ strFileTypeName,
 * rFilePatterns, bUseAsDefault }] }` and get the chosen path back, or nothing when cancelled). Copied, not imported:
 * plugins never import each other. A click starts it, never a render. Resolves to an absolute path, or null
 * (cancelled, or no such API on this Steam build). Used by the achievement packs' Import (ADR-0081).
 */
type OpenFileDialog = (opts: { strTitle: string; rgFilters: { strFileTypeName: string; rFilePatterns: string[]; bUseAsDefault?: boolean }[] }) => Promise<string | undefined>;
type SystemApi = { System?: { OpenFileDialog?: OpenFileDialog } };

function clientOf(win: Window): SystemApi | undefined {
    return (win as unknown as { SteamClient?: SystemApi }).SteamClient ?? (Reflect.get(globalThis, 'SteamClient') as unknown as SystemApi | undefined);
}

/** A JSON file chosen in Steam's dialog. `win`: the window the dialog belongs to. */
export async function pickJsonFile(title: string, win: Window = window): Promise<string | null> {
    const client = clientOf(win);
    const open = client?.System?.OpenFileDialog;
    if (typeof open !== 'function') return null;
    try {
        const path = await open.call(client!.System, { strTitle: title, rgFilters: [{ strFileTypeName: 'Achievement packs (*.json)', rFilePatterns: ['*.json'], bUseAsDefault: true }] });
        return typeof path === 'string' && path ? path : null;
    } catch {
        return null;
    }
}

/** Whether this Steam build has the dialog (Import shows only then). */
export function canPickFiles(): boolean {
    return typeof clientOf(window)?.System?.OpenFileDialog === 'function';
}
