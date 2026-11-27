// app/service-check: adding an account (the Add source window, in Settings and in onboarding). Save it, ask the service
// whether it accepts it, and say why not in a few words. The whole thing gives up after CHECK_TIMEOUT_MS: a check that
// never came back left the window on "Checking the account..." for good (a RetroAchievements report, 2026-11-27).
import type { backend as Backend } from "../ports/backend";

export type Service = "igdb" | "screenscraper" | "steamgriddb" | "retroachievements";

/** How long the save and the check may take together before the window gives up and offers Retry. */
export const CHECK_TIMEOUT_MS = 60_000;

/**
 * Why a check did not pass. `refused`: the service said no to the values (a Retry with the same values will not help).
 * The others are worth a Retry: `timeout` (no answer in time), `busy` (other work held the plugin's call queue),
 * `offline` (no HTTP answer), `server` (an HTTP error from the service), `error` (anything else).
 */
export type CheckFailure = "refused" | "timeout" | "busy" | "offline" | "server" | "error";

export interface CheckResult {
    ok: boolean;
    message: string;
    failure?: CheckFailure;
}

export interface ServiceCheckDeps {
    backend: Pick<typeof Backend, "saveServiceCredentials" | "testService">;
    /** The backend call running now (transport diagnostics), to tell a hung service from a busy queue. */
    runningCall: () => string | undefined;
    timeoutMs?: number;
}

/** The backend's check message (rpc.lua TestServiceConnection), sorted into a kind and shortened; a refusal keeps its words. */
export function classifyCheck(label: string, raw: string): { failure: CheckFailure; message: string } {
    const reached = /could not be reached \((.*)\)/i.exec(raw);
    if (reached) {
        const timedOut = /timed? ?out/i.test(reached[1] ?? "");
        return { failure: "offline", message: timedOut ? `${label} timed out.` : `${label} is offline or unreachable.` };
    }
    const http = /answered HTTP (\d+)/i.exec(raw);
    if (http) return { failure: "server", message: `${label} is not answering (HTTP ${http[1]}).` };
    if (/limiting requests/i.test(raw)) return { failure: "server", message: `${label} is busy, try again later.` };
    if (/^The check failed/i.test(raw)) return { failure: "error", message: "The check failed, see the plugin log." };
    return { failure: "refused", message: `${raw} Nothing was saved.` };
}

const TIMED_OUT = Symbol("timed out");

/**
 * Save `credentials`, then check them. An account that does not pass is removed again (every key saved blank), so a wrong
 * value never sits in the plugin pretending to be a source. `message` is what to show: the reason, or that it is connected
 * (nothing is fetched until the user decides, ADR-0086).
 */
export async function checkAccount(deps: ServiceCheckDeps, service: Service, label: string, credentials: Record<string, string>): Promise<CheckResult> {
    const { backend } = deps;
    const blank = () => {
        // Queued behind a call that may still be running, so it lands after it (one lane, first in first out).
        const empty = Object.fromEntries(Object.keys(credentials).map((k) => [k, ""]));
        void backend.saveServiceCredentials(empty).catch(() => {});
    };
    const run = async (): Promise<CheckResult> => {
        const saved = await backend.saveServiceCredentials(credentials).catch(() => ({ success: false }));
        if (!saved.success) return { ok: false, failure: "error", message: "Could not save the account." };
        let check: { ok?: boolean; message?: string; error?: string };
        try {
            check = await backend.testService(service);
        } catch (error) {
            check = { ok: false, message: `The check failed: ${String(error)}` };
        }
        if (check.ok) return { ok: true, message: `✓ ${label} connected.` };
        blank();
        return { ok: false, ...classifyCheck(label, check.message ?? check.error ?? "The account was not accepted.") };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), deps.timeoutMs ?? CHECK_TIMEOUT_MS);
    });
    try {
        const res = await Promise.race([run(), deadline]);
        if (res !== TIMED_OUT) return res;
    } finally {
        clearTimeout(timer);
    }
    // No answer in time: either the check ran and the service hung, or other work held the plugin's queue.
    const running = deps.runningCall();
    blank();
    return running && running !== "TestServiceConnection" && running !== "SaveServiceCredentials"
        ? { ok: false, failure: "busy", message: "Timed out: the plugin is busy, try again." }
        : { ok: false, failure: "timeout", message: `Timed out: no answer from ${label}.` };
}
