// A locked achievement's grey picture. Steam draws a locked achievement from a grey icon and an unlocked one from the colour
// one; most sources (a store's, a pack's) give only the colour one, which Steam would draw in colour while locked. The grey
// one is made here, once per picture, in memory only (stored, it would double the achievements file). Until it is ready the
// colour picture shows and `onReady` runs, so the caller builds the list again.

const SIZE = 128;
const ready = new Map<string, string>();
const failed = new Set<string>();
const pending = new Set<string>();
const waiting = new Set<() => void>();
// Pictures are made a few at a time and not while Steam is starting: hundreds at once starved the plugin's other image
// requests (a store's art failed to fetch at every start).
const MAX_AT_ONCE = 3;
const START_AFTER_MS = 10_000;
const loadedAt = Date.now();
const queue: string[] = [];
let running = 0;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The grey picture, or undefined (not made yet, or it cannot be: a picture the canvas may not read). */
export function greyIconOf(url: string): string | undefined {
    const hit = ready.get(url);
    if (hit) return hit;
    if (!failed.has(url) && !pending.has(url) && typeof document !== "undefined") {
        pending.add(url);
        queue.push(url);
        pump();
    }
    return undefined;
}

function pump(): void {
    const wait = START_AFTER_MS - (Date.now() - loadedAt);
    if (wait > 0) {
        if (pumpTimer === undefined) pumpTimer = setTimeout(() => ((pumpTimer = undefined), pump()), wait);
        return;
    }
    while (running < MAX_AT_ONCE && queue.length > 0) {
        running++;
        make(queue.shift()!);
    }
}

/** Run `fn` (once, shortly after) when a grey picture became ready. */
export function whenGreyReady(fn: () => void): void {
    waiting.add(fn);
}

function done(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
        timer = undefined;
        for (const fn of [...waiting]) {
            try {
                fn();
            } catch {
                /* the list is built again next time */
            }
        }
    }, 400);
}

function make(url: string): void {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const give = (value?: string) => {
        pending.delete(url);
        running--;
        pump();
        if (value) {
            ready.set(url, value);
            done();
        } else failed.add(url);
    };
    img.onload = () => {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = SIZE;
            canvas.height = SIZE;
            const ctx = canvas.getContext("2d");
            if (!ctx) return give();
            ctx.drawImage(img, 0, 0, SIZE, SIZE);
            const px = ctx.getImageData(0, 0, SIZE, SIZE);
            const d = px.data;
            for (let i = 0; i < d.length; i += 4) {
                const g = Math.round(d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114);
                d[i] = d[i + 1] = d[i + 2] = g;
            }
            ctx.putImageData(px, 0, 0);
            const out = canvas.toDataURL("image/jpeg", 0.85);
            give(out.startsWith("data:image/jpeg;base64,") ? out : undefined);
        } catch {
            give(); // a tainted canvas (no CORS): the colour picture stays
        }
    };
    img.onerror = () => give();
    img.src = url;
}
