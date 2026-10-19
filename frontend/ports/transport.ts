// The one function that calls the backend (migration plan M4c; moved from rpc.ts
// verbatim). rpc.ts and ports/backend.ts both call through this.
//
// Millennium's Lua host serves one call at a time (ADR-0051), so calls wait in a queue. The queue has
// priority lanes (dataflow plan Phase 1, ADR-0060): when the host is free, the oldest call of the most
// urgent non-empty lane goes next. A call already running is never interrupted. The lane is the
// caller's choice (app/); this port only keeps the order and the timings.

/** Most urgent first: the page the user is looking at, other user actions, community media, background jobs. */
export const LANES = ["view", "normal", "media", "background"] as const;
export type Lane = (typeof LANES)[number];

export interface CallOptions {
  /** Default "normal". */
  lane?: Lane;
}

/** One finished call, for rpcDiagnostics() (dataflow plan Phase 0). Times are Date.now() ms. */
export interface CallTiming {
  name: string;
  /** EnsureFresh: the parts asked, "(disk)" for a noNetwork paint. */
  detail?: string;
  lane: Lane;
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  ok: boolean;
}

interface Job {
  name: string;
  payload: object;
  lane: Lane;
  queuedAt: number;
  resolve(value: unknown): void;
  reject(err: unknown): void;
}

const queues: Record<Lane, Job[]> = { view: [], normal: [], media: [], background: [] };
let running: { name: string; lane: Lane; startedAt: number } | null = null;

const HISTORY = 200;
const history: CallTiming[] = [];

async function executeCall<R>(name: string, payload: object = {}): Promise<R> {
  const millennium = (window as any)['Millennium'];
  const callFn = millennium ? millennium['callServerMethod'] : undefined;
  const candidatePlugins = ['steam-cartridges-dev', 'steam-cartridges'];
  let lastError: any;
  for (const plugin of candidatePlugins) {
    try {
      if (typeof callFn === 'function') {
        const raw = await callFn.call(millennium, plugin, name, {
          payload: JSON.stringify(payload),
        });
        return JSON.parse(raw as string) as R;
      }
    } catch (err: any) {
      lastError = err;
      if (String(err).includes('plugin not running')) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function nextJob(): Job | undefined {
  for (const lane of LANES) {
    const job = queues[lane].shift();
    if (job) return job;
  }
  return undefined;
}

/** A short label for the diagnostics: which parts an EnsureFresh asked, never the payload itself. */
function detailOf(payload: any): string | undefined {
  if (!Array.isArray(payload?.parts)) return undefined;
  return payload.parts.join("+") + (payload.context?.noNetwork ? " (disk)" : "");
}

function pump(): void {
  if (running) return;
  const job = nextJob();
  if (!job) return;
  const startedAt = Date.now();
  running = { name: job.name, lane: job.lane, startedAt };
  const finish = (ok: boolean) => {
    history.push({ name: job.name, detail: detailOf(job.payload), lane: job.lane, queuedAt: job.queuedAt, startedAt, endedAt: Date.now(), ok });
    if (history.length > HISTORY) history.shift();
    running = null;
    pump();
  };
  executeCall(job.name, job.payload).then(
    (value) => {
      job.resolve(value);
      finish(true);
    },
    (err) => {
      job.reject(err);
      finish(false);
    },
  );
}

export function call<R>(name: string, payload: object = {}, opts: CallOptions = {}): Promise<R> {
  const lane: Lane = opts.lane && LANES.includes(opts.lane) ? opts.lane : "normal";
  return new Promise<R>((resolve, reject) => {
    queues[lane].push({ name, payload, lane, queuedAt: Date.now(), resolve: resolve as (v: unknown) => void, reject });
    // A microtask, so calls made in the same tick are all queued before the first is picked.
    queueMicrotask(pump);
  });
}

/** The call running now, what waits per lane, and the last 200 finished calls (oldest first). */
export function transportDiagnostics(): {
  running: { name: string; lane: Lane; forMs: number } | null;
  queued: Record<Lane, string[]>;
  recent: CallTiming[];
} {
  const now = Date.now();
  return {
    running: running ? { name: running.name, lane: running.lane, forMs: now - running.startedAt } : null,
    queued: {
      view: queues.view.map((j) => j.name),
      normal: queues.normal.map((j) => j.name),
      media: queues.media.map((j) => j.name),
      background: queues.background.map((j) => j.name),
    },
    recent: history.slice(),
  };
}
