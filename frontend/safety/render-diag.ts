// Safety: render diagnostics. When a Steam page shows "An error occurred while rendering this content" (Steam's own
// error boundary), the plugin log said nothing: surface and feature errors went to Steam's console only, and a render
// error thrown inside Steam's React was never seen at all. This module sends those to the plugin log (`[render]` lines,
// through backend.logEvent), with what a report needs and nothing a user must not share (ADR-0094): the error's kind and
// cleaned message, the component that failed, the top frames without a path, and the shape of the viewed game's data.
//
// Pure: the window, the console and the backend are given, so the unit test runs without Steam.
import type { GameRecord, Part } from "../kernel/record";

/** One `[render]` line is cut here; the backend cuts at 200 on its side. */
export const LINE_MAX = 190;
/** Distinct lines per session for this plugin's own errors and React's render reports; a loop of failing renders must not flood the log. */
export const DISTINCT_MAX = 20;
/** Distinct lines for errors that merely reach the window: Steam's own scripts throw too, and must not use up the room for the lines above. */
export const WINDOW_DISTINCT_MAX = 8;
/** Distinct lines for the plugin's own `logger.warn` / `logger.error` notes ("could not patch X"): each has its own room too. */
export const NOTE_DISTINCT_MAX = 12;

export interface ErrorSummary {
    name: string;
    message: string;
    /** `fn@file:line:col`, no directory, no host. */
    frames: string[];
    /** The stack names this plugin's own code (a frame from its bundle). */
    ours: boolean;
}

/** Message text that is safe to share: URLs, drive and home paths removed, whitespace collapsed, cut. */
export function cleanMessage(text: unknown, max = 110): string {
    return String(text ?? "")
        .replace(/https?:\/\/\S+/gi, "<url>")
        .replace(/file:\/\/\S+/gi, "<path>")
        .replace(/[A-Za-z]:[\\/][^\s'")]+/g, "<path>")
        .replace(/\/(?:home|Users|run|mnt|var)\/[^\s'")]+/g, "<path>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
}

/** `at fn (https://host/dir/file.js:12:34)` or `fn@https://...` -> `fn@file.js:12:34`. */
export function cleanFrame(line: string): string | undefined {
    const text = line.trim();
    let fn = "";
    let loc = "";
    let m = text.match(/^at\s+(?:async\s+)?(.*?)\s+\((.*)\)$/);
    if (m) {
        fn = m[1] ?? "";
        loc = m[2] ?? "";
    } else if ((m = text.match(/^at\s+(.*)$/))) {
        loc = m[1] ?? "";
    } else if ((m = text.match(/^(.*?)@(.*)$/))) {
        fn = m[1] ?? "";
        loc = m[2] ?? "";
    } else {
        return undefined;
    }
    const file = loc.match(/([^\\/\s:()]+\.[A-Za-z]+(?::\d+(?::\d+)?)?)\s*$/)?.[1] ?? "?";
    return `${fn.replace(/[^\w$.<>\[\]]/g, "").slice(0, 40) || "anon"}@${file}`;
}

export function summarizeError(err: unknown, ownMarkers: readonly string[] = []): ErrorSummary {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null | undefined;
    const isObj = typeof err === "object" && err !== null;
    const name = cleanMessage(isObj ? (e?.name ?? "Error") : typeof err, 30) || "Error";
    const message = cleanMessage(isObj ? e?.message : err);
    const stack = isObj && typeof e?.stack === "string" ? e.stack : "";
    const frames = stack
        .split("\n")
        .map((l) => cleanFrame(l))
        .filter((f): f is string => !!f)
        .slice(0, 3);
    const ours = ownMarkers.length > 0 && ownMarkers.some((marker) => stack.includes(marker));
    return { name, message, frames, ours };
}

/** What React says about a caught render error: the failing component, its parents, the boundary that caught it. */
export interface ReactReport {
    component: string;
    parents: string[];
    boundary?: string;
}

/**
 * Reads React's console.error text for a caught render error. React 18/19 write "The above error occurred in the <X> component"
 * followed by a component stack ("    at X (file:1:2)\n    at Parent ..."), and "React will try to recreate this component tree from
 * scratch using the error boundary you provided, B." Arguments may be format-string style (`%s`): the name is then the next argument.
 */
export function parseReactReport(args: readonly unknown[]): ReactReport | undefined {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (!/above error occurred|error boundary/i.test(first)) return undefined;
    const joined = args.map((a) => (typeof a === "string" ? a : "")).join("\n");
    let component = first.match(/occurred in the <([^>%]+)> component/)?.[1];
    if (!component && /occurred in the <%s> component/.test(first)) component = typeof args[1] === "string" ? args[1] : undefined;
    const names = [...joined.matchAll(/^\s*at\s+([A-Za-z_$][\w$.]*)/gm)].map((m) => m[1] ?? "").filter(Boolean);
    const boundary = joined.match(/using the error boundary you provided,\s*([\w$]+(?:\.[\w$]+)*)/)?.[1];
    const comp = (component ?? names[0] ?? "unknown").slice(0, 40);
    const parents = names.filter((n, i) => i > 0 || n !== comp).slice(0, 4).map((n) => n.slice(0, 40));
    return { component: comp, parents, boundary: boundary?.slice(0, 40) };
}

function partText(name: string, part: Part<unknown> | undefined): string {
    if (!part) return `${name}=none`;
    return `${name}=${part.status}${part.source ? `(${String(part.source).slice(0, 16)})` : ""}`;
}

/**
 * The shape of one game's record, in numbers only (no title, no path). The achievements are counted because a malformed
 * entry (a missing name, an icon that is not a string, a percentage that is not a number) is what Steam's own section
 * throws on; the count of malformed entries is the clue a log must carry.
 */
export function summarizeRecord(record: GameRecord | undefined): string {
    if (!record) return "record=none";
    const parts = [
        partText("identity", record.identity),
        partText("metadata", record.metadata),
        partText("achievements", record.achievements),
        partText("media", record.media),
        partText("artwork", record.artwork),
    ];
    const set = record.achievements?.data;
    const items = Array.isArray(set?.schema?.achievements) ? set.schema.achievements : [];
    if (set) {
        let bad = 0;
        let noIcon = 0;
        let hidden = 0;
        for (const a of items) {
            const x = a as unknown as Record<string, unknown> | null;
            if (!x || typeof x.id !== "string" || typeof x.name !== "string" || typeof x.description !== "string" || typeof x.global_pct !== "number") bad++;
            if (!x || typeof x.icon !== "string" || x.icon === "") noIcon++;
            if (x && x.hidden === true) hidden++;
        }
        const unlocks = set.unlocks && typeof set.unlocks === "object" ? Object.keys(set.unlocks).length : -1;
        parts.push(`ach(total=${set.schema?.total ?? "?"}, listed=${items.length}, unlocked=${unlocks}, malformed=${bad}, no-icon=${noIcon}, hidden=${hidden}, native=${set.schema?.native_appid ? "yes" : "no"})`);
    }
    const media = record.media?.data?.items;
    if (Array.isArray(media)) parts.push(`media-items=${media.length}`);
    const cats = record.metadata?.data as { categories?: unknown; badge_category_ids?: unknown } | undefined;
    if (cats) parts.push(`categories=${Array.isArray(cats.categories) ? cats.categories.length : typeof cats.categories}`);
    return parts.join(", ");
}

export interface RenderDiagOptions {
    /** One line in the plugin log: `backend.logEvent`. */
    send(tag: string, message: string): void;
    /** What the plugin knew when the error came (features, surfaces, the viewed game's record shape). Called at most once per distinct error. */
    context(): string;
    /** Substrings of a stack that mean "this plugin's own code". */
    ownMarkers?: readonly string[];
    now?: () => number;
}

export interface RenderDiag {
    /** A caught error from the plugin (a surface, a feature, a hook). */
    reportPlugin(source: string, err: unknown): void;
    /** An error that reached the window (thrown in Steam's React or in any script): `window.onerror` / `unhandledrejection`. */
    reportWindow(kind: "error" | "rejection", err: unknown): void;
    /** A `logger.warn` / `logger.error` of the plugin: the failure sensors the code already has ("Could not feed AchievementsFullStore"). */
    reportNote(level: "warn" | "error", args: readonly unknown[]): void;
    /** React's console.error for a render error caught by an error boundary (Steam's "An error occurred while rendering this content"). */
    reportConsole(args: readonly unknown[]): void;
    counts(): { distinct: number; total: number; suppressed: number };
}

export function createRenderDiag(opts: RenderDiagOptions): RenderDiag {
    const own = opts.ownMarkers ?? [];
    const seen = new Map<string, number>();
    const distinct = { w: 0, n: 0, other: 0 };
    let total = 0;
    let suppressed = 0;
    let warnedFull = false;

    const emit = (line: string) => {
        try {
            opts.send("render", line.slice(0, LINE_MAX));
        } catch {
            /* the log must never break a render */
        }
    };

    /** Logs the first time a signature is seen, and again at its 10th and 100th repeat; the first time also logs the context. */
    const record = (signature: string, line: (n: number) => string): void => {
        total++;
        const n = (seen.get(signature) ?? 0) + 1;
        const cls = signature.startsWith("w|") ? "w" : signature.startsWith("n|") ? "n" : "other";
        const max = cls === "w" ? WINDOW_DISTINCT_MAX : cls === "n" ? NOTE_DISTINCT_MAX : DISTINCT_MAX;
        if (n === 1 && distinct[cls] >= max) {
            suppressed++;
            if (!warnedFull) {
                warnedFull = true;
                emit(`too many different errors this session; the rest are counted, not logged`);
            }
            return;
        }
        if (n === 1) distinct[cls]++;
        seen.set(signature, n);
        if (n !== 1 && n !== 10 && n !== 100) return;
        emit(line(n));
        if (n === 1) {
            try {
                emit(`context: ${opts.context()}`);
            } catch {
                emit("context: unavailable");
            }
        }
    };

    return {
        reportPlugin(source, err) {
            const s = summarizeError(err, own);
            const where = cleanMessage(source, 40);
            record(`p|${where}|${s.name}|${s.message}|${s.frames[0] ?? ""}`, (n) => `plugin error in ${where}: ${s.name}: ${s.message}${s.frames.length ? ` @ ${s.frames.join(" < ")}` : ""}${n > 1 ? ` (x${n})` : ""}`);
        },
        reportWindow(kind, err) {
            const s = summarizeError(err, own);
            record(`w|${kind}|${s.name}|${s.message}|${s.frames[0] ?? ""}`, (n) => `${kind === "rejection" ? "unhandled rejection" : "window error"}${s.ours ? " (from this plugin)" : ""}: ${s.name}: ${s.message}${s.frames.length ? ` @ ${s.frames.join(" < ")}` : ""}${n > 1 ? ` (x${n})` : ""}`);
        },
        reportNote(level, args) {
            const text = args.find((a) => typeof a === "string");
            const errArg = args.find((a) => typeof a === "object" && a !== null && "message" in (a as object));
            const msg = cleanMessage(String(text ?? "").replace(/\d{6,}/g, "<id>"), 90);
            if (!msg && !errArg) return;
            const s = errArg ? summarizeError(errArg, own) : undefined;
            record(`n|${level}|${msg}|${s?.message ?? ""}`, (n) => `${level}: ${msg}${s ? `: ${s.name}: ${s.message}${s.frames.length ? ` @ ${s.frames.join(" < ")}` : ""}` : ""}${n > 1 ? ` (x${n})` : ""}`);
        },
        reportConsole(args) {
            const r = parseReactReport(args);
            if (!r) {
                // Steam's own boundary wording, when it writes its own line instead of React's.
                const first = typeof args[0] === "string" ? args[0] : "";
                if (/error occurred while rendering|Error Reference/i.test(first)) {
                    const m = cleanMessage(first.replace(/\d{6,}/g, "<id>"), 110);
                    record(`n|console|${m}`, (n) => `Steam error box text: ${m}${n > 1 ? ` (x${n})` : ""}`);
                }
                return;
            }
            const errArg = args.find((a) => typeof a === "object" && a !== null && "message" in (a as object));
            const s = errArg ? summarizeError(errArg, own) : undefined;
            record(`r|${r.component}|${s?.message ?? ""}`, (n) => `React caught a render error in <${r.component}>${r.parents.length ? ` (inside ${r.parents.join(" > ")})` : ""}${r.boundary ? `, boundary ${r.boundary}` : ""}${s ? `: ${s.name}: ${s.message}${s.ours ? " (from this plugin)" : ""}` : ""}${n > 1 ? ` (x${n})` : ""}`);
        },
        counts: () => ({ distinct: seen.size, total, suppressed }),
    };
}

export interface InstallTargets {
    win: {
        addEventListener(type: string, fn: (ev: any) => void): void;
        removeEventListener(type: string, fn: (ev: any) => void): void;
    };
    con: { error: (...args: unknown[]) => void };
}

/**
 * Hooks the three places a render error shows up. The console tap only watches `console.error`, passes every call straight to the
 * original first, and never throws; it reads React's text and nothing else. Returns the undo.
 */
export function installRenderDiag(diag: RenderDiag, { win, con }: InstallTargets): () => void {
    const onError = (ev: { error?: unknown; message?: unknown }) => diag.reportWindow("error", ev?.error ?? ev?.message);
    const onRejection = (ev: { reason?: unknown }) => diag.reportWindow("rejection", ev?.reason);
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);

    const original = con.error;
    let busy = false;
    const tap = function (this: unknown, ...args: unknown[]) {
        try {
            return original.apply(this, args);
        } finally {
            if (!busy) {
                busy = true;
                try {
                    diag.reportConsole(args);
                } catch {
                    /* never break console.error */
                } finally {
                    busy = false;
                }
            }
        }
    };
    con.error = tap;

    return () => {
        win.removeEventListener("error", onError);
        win.removeEventListener("unhandledrejection", onRejection);
        if (con.error === tap) con.error = original;
    };
}
