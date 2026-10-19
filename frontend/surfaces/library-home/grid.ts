// Surface `library-home` (migration plan M3.10): moved from renderers/library-home.tsx.
import { afterPatch } from '@steambrew/client';
import { Steam, waitFor } from 'steambrew-utils';
import { logger } from '../../logger';
import type { SurfaceDeps } from '../../kernel/surface';
import { isShortcutAppId } from '../../kernel/appid';

/** Set by createLibraryHomeSurface (plan § 7.0 D3/D6); open defaults until then. */
export const deps: SurfaceDeps & {
  /** Capture stats per shortcut (app/library-stats, loaded before install and after a quit); O(1) reads. */
  stats: { get(appid: number): { newest: number; screenshots: number } | undefined; size(): number };
} = { isEnabled: () => true, reportError: () => {}, stats: { get: () => undefined, size: () => 0 } };

/**
 * Fills in recent-activity timestamps for non-Steam games from their captures.
 *
 * Steam tracks playtime for shortcuts it launched itself, but plenty of
 * non-Steam games show no date at all while clearly having been played — on the
 * dev machine, Breath of the Wild has 14 screenshots from March 2026 and a
 * last-played of `0`. A screenshot is hard evidence the game ran, so the newest
 * capture serves as a lower bound.
 *
 * We patch the *data* rather than the grid's markup (ADR-0009), so Steam's own
 * sorting and date labels work with it and there is no DOM to keep in sync.
 *
 * ## Which fields can actually be written
 *
 * `AppOverview` fields are declared with metadata, and only some are plain
 * observables (from Steam's own bundle):
 *
 *   rt_recent_activity_time:  { observable: true }
 *   rt_last_time_played:      { fnCustomSetter: (e, t) => e.SetLastTimePlayed(t), … }
 *
 * `rt_last_time_played` routes through a custom setter onto the underlying
 * protobuf, so a plain assignment only creates a shadow property that Steam
 * discards on its next sync. It reads back correctly for a moment, which makes
 * this look like it works. We therefore write only the observable fields.
 *
 * Only ever moves a value forward, so nothing we do can make a game look less
 * recently played than Steam already believes.
 */

/**
 * Read Steam's app store from the global scope on every access.
 *
 * `steambrew-utils` captures `Steam.AppStore` once at module load
 * (`Reflect.get(globalThis, "appStore")`). Plugins load before Steam creates
 * that global, so the captured value is `undefined` forever and every lookup
 * through it silently yields nothing. Reading the global each time is the only
 * reliable route.
 */
function appStore(): { allApps?: Steam.AppOverview[] } | undefined {
  return Reflect.get(globalThis, 'appStore') as { allApps?: Steam.AppOverview[] } | undefined;
}

/** Same problem, same fix. */
function collectionStore(): Record<PropertyKey, unknown> | undefined {
  return Reflect.get(globalThis, 'collectionStore') as
    | Record<PropertyKey, unknown>
    | undefined;
}

/**
 * Apply our data to one app overview, if we can improve on what Steam has.
 *
 * @returns true when a value was actually changed.
 */
function enrich(overview: Steam.AppOverview): boolean {
  const entry = deps.stats.get(overview.appid);
  if (!entry || entry.newest <= 0) return false;

  let changed = false;

  // Never move a timestamp backwards - Steam's own value wins when it is more
  // recent than our newest capture.
  if ((overview.rt_recent_activity_time ?? 0) < entry.newest) {
    overview.rt_recent_activity_time = entry.newest;
    changed = true;
  }
  if ((overview.rt_last_time_played_or_installed ?? 0) < entry.newest) {
    overview.rt_last_time_played_or_installed = entry.newest;
    changed = true;
  }

  // NOT rt_last_time_played: it has a custom setter backed by protobuf state
  // (see the note above) and a plain write does not survive.

  return changed;
}

/**
 * Patch the store method Steam calls whenever app overviews change.
 *
 * `afterPatch` runs once Steam has populated the overviews, so our values are
 * written last and survive into the render.
 */
export async function register(): Promise<VoidFunction | undefined> {
  // Nothing to contribute: skip the patch entirely rather than adding a
  // no-op to a hot path.
  if (deps.stats.size() === 0) {
    logger.info('No non-Steam captures found; skipping the library grid patch.');
    return undefined;
  }

  // Created during startup; patching before it exists silently does nothing.
  const store = (await waitFor(collectionStore))!;

  // `collectionStore` is a class instance, so OnAppOverviewChange lives on its
  // PROTOTYPE, not the instance. Patching the instance appears to succeed and
  // then never fires - the only symptom is that nothing happens. Patch whichever
  // object actually owns the method.
  const owner = Object.prototype.hasOwnProperty.call(store, 'OnAppOverviewChange')
    ? store
    : (Object.getPrototypeOf(store) as Record<PropertyKey, unknown>);

  if (typeof owner?.['OnAppOverviewChange'] !== 'function') {
    logger.warn('CollectionStore.OnAppOverviewChange not found; grid will not update live.');
    void enrichLoadedApps();
    return undefined;
  }

  const patch = afterPatch(
    owner,
    'OnAppOverviewChange',
    (args: unknown[], ret: unknown) => {
      if (!deps.isEnabled('library-home')) return ret;
      try {
        const apps = args[0];
        if (!Array.isArray(apps)) return ret;

        for (const app of apps as Steam.AppOverview[]) {
          // Cheap early-out: this runs on every overview change, including
          // large batches during startup.
          if (app?.appid && isShortcutAppId(app.appid)) enrich(app);
        }
      } catch (err) {
        deps.reportError('library-home', err); // fail-open (plan § 7.0 D6)
      }

      return ret;
    },
  );

  // OnAppOverviewChange only fires on subsequent changes, so apply to whatever
  // is already loaded. The app list fills in asynchronously during startup, so
  // this waits on it - deliberately NOT awaited, or plugin startup would block
  // until the library finishes loading.
  void enrichLoadedApps();

  logger.info('Library grid patch registered.');
  return patch.unpatch;
}

/**
 * Apply our values to every non-Steam app currently in the store.
 *
 * Reports what it did: a silent no-op here is indistinguishable from the patch
 * working, which cost real debugging time.
 */
async function enrichLoadedApps(): Promise<void> {
  try {
    // Wait for the list to be POPULATED, not merely present. At plugin-load
    // time `appStore` already exists but `allApps` is still empty, so waiting
    // on the object alone silently enriches nothing.
    const apps =
      (await waitFor(() => {
        const list = appStore()?.allApps;
        return Array.isArray(list) && list.length > 0 ? list : undefined;
      })) ?? [];

    let updated = 0;
    for (const app of apps) {
      if (app?.appid && isShortcutAppId(app.appid) && enrich(app)) updated++;
    }

    logger.info(`Filled in last-played for ${updated} of ${deps.stats.size()} game(s) with captures.`);
  } catch (error) {
    logger.warn('Could not enrich already-loaded apps:', error);
  }
}

/** Apply the stats again (app/library-stats re-read them after a game quit), so new captures reach the grid. */
export async function refresh(): Promise<void> {
  await enrichLoadedApps();
}
