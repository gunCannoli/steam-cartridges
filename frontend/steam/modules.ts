import { findModuleByExport } from '@steambrew/client';
import { logger } from '../logger';

/** Steam's react/jsx-runtime module: the one every jsx hook patches (steam/jsx-hook.ts, ADR-0041). */
export interface JsxRuntime {
  jsx(type: unknown, props: unknown, key?: unknown): unknown;
  jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}

let cachedJsxRuntime: JsxRuntime | undefined;

/**
 * Steam's jsx runtime, found by its export names (never a module id) and remembered once found.
 * The one lookup for every jsx hook (guardrail 3: one scanner); undefined until Steam has loaded it.
 */
export function jsxRuntime(): JsxRuntime | undefined {
  if (cachedJsxRuntime) return cachedJsxRuntime;
  const found = findModuleByExport(
    (moduleExport: unknown, exportName?: unknown) =>
      (exportName === 'jsx' || exportName === 'jsxs') && typeof moduleExport === 'function',
  ) as JsxRuntime | undefined;
  if (!found || typeof found.jsx !== 'function' || typeof found.jsxs !== 'function') return undefined;
  cachedJsxRuntime = found;
  return found;
}

/**
 * Access to Steam's own webpack module cache.
 *
 * `@steambrew/client` exposes `findModuleExport`, but it only searches modules
 * that have already been *evaluated*. Several things we need - the app-details
 * section registry in particular - may not have been touched yet when the
 * plugin loads. So we take the require function directly and can force-evaluate
 * any factory by id.
 *
 * Steam hands out its require to any chunk that asks: push a chunk whose
 * factory captures the third argument. This is the documented webpack runtime
 * contract, not a private hook, and it is how the research in
 * docs/steam-components.md was done.
 *
 * NOTHING here may resolve by numeric module id. Ids reshuffle between Steam
 * builds (ADR-0005 and the AGENTS.md reuse rule). Every lookup is by signature:
 * real `prototype` method names, which survive minification because they are
 * property names rather than bindings.
 */

interface WebpackRequire {
  (id: string): unknown;
  m: Record<string, unknown>;
}

type ChunkGlobal = Array<[string[], Record<string, unknown>, ((r: WebpackRequire) => void)?]>;

let cachedRequire: WebpackRequire | undefined;
let requireResolved = false;

/** Capture Steam's webpack require. Cached; safe to call repeatedly. */
export function steamRequire(): WebpackRequire | undefined {
  if (requireResolved) return cachedRequire;
  requireResolved = true;

  try {
    const chunks = Reflect.get(globalThis, 'webpackChunksteamui') as ChunkGlobal | undefined;
    if (!Array.isArray(chunks)) {
      logger.warn('webpackChunksteamui is unavailable; native components disabled.');
      return undefined;
    }

    const key = `__nsga_probe_${Date.now()}`;
    let captured: WebpackRequire | undefined;

    chunks.push([
      [key],
      { [key]: (_m: unknown, _e: unknown, r: WebpackRequire) => (captured = r) },
      (r) => {
        r((r as unknown as { s: string }).s = key);
      },
    ]);

    cachedRequire = captured;
    if (!captured) logger.warn('Could not capture Steam\'s module require.');
  } catch (error) {
    logger.warn('Could not capture Steam\'s module require:', error);
  }

  return cachedRequire;
}

/**
 * Every export of every module, evaluated lazily.
 *
 * Evaluating a factory can throw (some modules assume a context they do not
 * have yet), so each is guarded individually and a failure just skips that
 * module rather than aborting the scan.
 */
function* allExports(): Generator<{ id: string; key: string; value: unknown }> {
  const req = steamRequire();
  if (!req) return;

  for (const id of Object.keys(req.m)) {
    let module: unknown;
    try {
      module = req(id);
    } catch {
      continue;
    }
    if (!module || (typeof module !== 'object' && typeof module !== 'function')) continue;

    let keys: string[];
    try {
      keys = Object.keys(module as object);
    } catch {
      continue;
    }

    for (const key of keys) {
      let value: unknown;
      try {
        value = (module as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      yield { id, key, value };
    }
  }
}

/** True when `value` is a class whose prototype has every named method. */
function hasPrototypeMethods(value: unknown, methods: string[]): boolean {
  if (typeof value !== 'function') return false;
  const proto = (value as { prototype?: object }).prototype;
  if (!proto) return false;

  try {
    const names = Object.getOwnPropertyNames(proto);
    return methods.every((m) => names.includes(m));
  } catch {
    return false;
  }
}

/** True when `value` is an object/singleton whose prototype has every named method. */
function isSingletonWith(value: unknown, methods: string[]): boolean {
  if (!value || typeof value !== 'object') return false;

  try {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (!proto) return false;
    const names = Object.getOwnPropertyNames(proto);
    return methods.every((m) => names.includes(m));
  } catch {
    return false;
  }
}

const resolveCache = new Map<string, unknown>();

/**
 * Find a Steam export by signature, once, and remember the answer.
 *
 * `label` is both the cache key and what gets logged when resolution fails, so
 * make it descriptive.
 */
export function resolveOnce<T>(label: string, predicate: (value: unknown) => boolean): T | undefined {
  if (resolveCache.has(label)) return resolveCache.get(label) as T | undefined;

  let found: unknown;
  for (const { value } of allExports()) {
    if (predicate(value)) {
      found = value;
      break;
    }
  }

  if (!found) logger.warn(`Could not resolve ${label}; that feature will be skipped.`);
  resolveCache.set(label, found);
  return found as T | undefined;
}

/** Resolve a class by the methods on its prototype. */
export function resolveClass<T>(label: string, methods: string[]): T | undefined {
  return resolveOnce<T>(label, (v) => hasPrototypeMethods(v, methods));
}

/** Resolve a live singleton (a store) by the methods on its prototype. */
export function resolveSingleton<T>(label: string, methods: string[]): T | undefined {
  return resolveOnce<T>(label, (v) => isSingletonWith(v, methods));
}

/** Resolve a plain object export by the own-property function names it carries. */
export function resolveService<T>(label: string, methods: string[]): T | undefined {
  return resolveOnce<T>(label, (v) => {
    if (!v || typeof v !== 'object') return false;
    return methods.every((m) => typeof (v as Record<string, unknown>)[m] === 'function');
  });
}

