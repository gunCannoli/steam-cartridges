// Adding an account in Settings: save it, ask the service whether it accepts it, and say what happens next.
import { backend } from "../ports/backend";

type Service = "igdb" | "screenscraper" | "steamgriddb" | "retroachievements";

/** What the player is told once an account is connected (the first fetch runs over every game already in the library). */
export const FETCH_NOTE =
    "Your library is being fetched now, in the background; it can take a few minutes. The progress bar is at the top of this panel.";

/**
 * Save `credentials`, then check them. A refused account is removed again (every key saved blank), so a wrong value
 * never sits in the plugin pretending to be a source. `message` is what to show: the reason, or the next step.
 */
export async function saveAndCheck(
    service: Service,
    label: string,
    credentials: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
    const saved = await backend.saveServiceCredentials(credentials);
    if (!saved.success) return { ok: false, message: "Failed to save credentials." };
    let check: { ok?: boolean; message?: string; error?: string };
    try {
        check = await backend.testService(service);
    } catch (error) {
        check = { ok: false, message: String(error) };
    }
    if (!check.ok) {
        const blank = Object.fromEntries(Object.keys(credentials).map((k) => [k, ""]));
        await backend.saveServiceCredentials(blank).catch(() => {});
        return { ok: false, message: `${check.message ?? check.error ?? "The account was not accepted."} Nothing was saved.` };
    }
    return { ok: true, message: `✓ ${label} connected. ${FETCH_NOTE}` };
}
