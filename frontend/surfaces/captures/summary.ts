import { logger } from '../../logger';
import { deps } from './deps';
import { steamQueryClients } from '../../steam/query-client';
import { ensureInViewerCache, keepViewerCache, onViewerCacheGivenUp, rememberScreenshots } from './viewer-cache';

onViewerCacheGivenUp(() => deps.log('viewer cache: Steam keeps rewriting its screenshot lists; the repair stopped for this session'));
import {
  captureApiState,
  clipsSince,
  screenshotsSince,
  spotlightStore,
  type GamePlaySession,
  type SteamClip,
  type SteamScreenshot,
} from '../../steam/stores';

/**
 * The Post-Game Summary API.
 *
 * This is the whole point of the plugin's new shape: we never build summary
 * markup. We put events into Steam's own `CGamePlaySession` and Steam's own
 * component renders them - native pager, native day separators, native date
 * headers ("Today" / "Yesterday" / "Sep 20"), native hover, native media
 * viewer. A Steam UI refresh carries us along instead of breaking us.
 *
 * Steam populates this itself for native games in `LoadPreviousSessionData`.
 * It never runs that for a shortcut, so we do the equivalent - using the same
 * two data sources Steam uses, which both work fine for non-Steam appids.
 */

/** Anything that can contribute events to a game's summary. */
export interface SummaryProvider {
  /** For logs and diagnostics. */
  readonly name: string;
  /**
   * Return the events to show for this game, or an empty array.
   *
   * Never throw: a provider that fails is skipped, and the others still render.
   */
  collect(context: SummaryContext): Promise<SummaryContribution>;
}

/** What a provider is told about the game it is contributing to. */
export interface SummaryContext {
  /** 32-bit appid, as the frontend and library URLs use. */
  readonly appid: number;
  /** 64-bit gameid, as screenshot folders and recordings use. */
  readonly gameid: string;
  /** Only include captures at or after this unix timestamp. 0 means all. */
  readonly since: number;
}

/** What a provider returns. Both lists are optional. */
export interface SummaryContribution {
  screenshots?: SteamScreenshot[];
  clips?: SteamClip[];
}

/**
 * The built-in provider: Steam's own local captures.
 *
 * Both calls work unmodified for a non-Steam game. The only reason Steam does
 * not show them already is the section filter and a 32-bit truncation in its
 * gameid helper - see docs/steam-components.md.
 */
export const localCapturesProvider: SummaryProvider = {
  name: 'steam-local-captures',
  async collect({ appid, gameid, since }) {
    const [screenshots, clips] = await Promise.all([
      screenshotsSince(appid, since),
      clipsSince(gameid, since),
    ]);
    return { screenshots, clips };
  },
};

const providers: SummaryProvider[] = [localCapturesProvider];

/**
 * Register an extra source of summary events.
 *
 * This is the extension point for provider plugins (ADR-0012): a
 * RetroAchievements or RetroArch plugin can add its own captures without the
 * core knowing anything about it. Returns a function that unregisters.
 */
export function registerSummaryProvider(provider: SummaryProvider): () => void {
  providers.push(provider);
  logger.info(`Registered summary provider: ${provider.name}`);

  return () => {
    const at = providers.indexOf(provider);
    if (at >= 0) providers.splice(at, 1);
  };
}

/** Run every provider, tolerating individual failures. */
async function collectAll(context: SummaryContext): Promise<Required<SummaryContribution>> {
  const results = await Promise.allSettled(providers.map((p) => p.collect(context)));

  const screenshots: SteamScreenshot[] = [];
  const clips: SteamClip[] = [];

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn(`Provider ${providers[index]?.name} failed:`, result.reason);
      return;
    }
    screenshots.push(...(result.value.screenshots ?? []));
    clips.push(...(result.value.clips ?? []));
  });

  return { screenshots, clips };
}

/** Does Steam's loopback server still serve this image? Only an explicit load error says no; a slow answer counts as yes. */
function imageServed(url: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      const done = (ok: boolean) => {
        img.onload = img.onerror = null;
        resolve(ok);
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      setTimeout(() => done(true), timeoutMs);
      img.src = url;
    } catch {
      resolve(true);
    }
  });
}

/**
 * Drop screenshots whose file the user deleted outside Steam. Steam keeps such a shot in its index and the summary
 * keeps showing it, so two independent checks run: the backend compares the index with the disk, and the image
 * itself is requested from Steam's loopback server (a 404 or load error means it is gone). Each outcome is logged
 * (counts only), so a report shows which check saw what.
 */
const toldSummary = new Map<string, string>();

async function dropDeletedScreenshots(gameid: string, shots: SteamScreenshot[]): Promise<SteamScreenshot[]> {
  if (shots.length === 0) {
    // Steam listed nothing: normal for a game without screenshots, a problem when the API itself failed.
    if (captureApiState.screenshots !== 'ok') {
      const line = `summary screenshots: steam=0 api=${captureApiState.screenshots}`;
      if (toldSummary.get(gameid) !== line) {
        toldSummary.set(gameid, line);
        deps.log(line);
      }
    }
    return shots;
  }

  const disk = await deps.missingScreenshots(gameid).catch(() => null);
  const gone = new Set(disk?.missing ?? []);
  const byDisk = (s: SteamScreenshot) => [...gone].some((name) => typeof s.strUrl === 'string' && s.strUrl.includes(name));

  // Two probes per image: the HTTP answer (no cache) and the image element. A 404/410 or a load error means it is gone.
  const probes = await Promise.all(
    shots.slice(0, 80).map(async (s) => {
      const url = typeof s.strUrl === 'string' ? s.strUrl : '';
      if (!url) return { status: undefined as number | undefined, img: true };
      const [status, img] = await Promise.all([deps.probeStatus(url), imageServed(url)]);
      return { status, img };
    }),
  );
  const isGone = (p: { status: number | undefined; img: boolean }) => p.status === 404 || p.status === 410 || (p.status === undefined && !p.img);
  const probed = probes.map((p) => !isGone(p));
  const statusCounts = { ok: 0, notFound: 0, other: 0, none: 0 };
  for (const p of probes) {
    if (p.status === undefined) statusCounts.none += 1;
    else if (p.status < 400) statusCounts.ok += 1;
    else if (p.status === 404 || p.status === 410) statusCounts.notFound += 1;
    else statusCounts.other += 1;
  }
  // The image element drew it although the server says it is gone: the browser cache, the stale thumbnail itself.
  const cachedOnly = probes.filter((p) => isGone(p) && p.img).length;
  const byProbe = (index: number) => index < probed.length && probed[index] === false;

  const probeDropsAll = probed.length > 0 && probed.every((ok) => !ok) && gone.size === 0;
  const kept = shots.filter((s, i) => !byDisk(s) && (probeDropsAll || !byProbe(i)));

  const dropped = shots.length - kept.length;
  const count = (test: (s: SteamScreenshot) => boolean) => shots.filter(test).length;
  const line =
    `summary screenshots: steam=${shots.length} index=${disk?.indexed ?? 'unknown'} ` +
    `missing_on_disk=${gone.size} not_served=${probed.filter((ok) => !ok).length} dropped=${dropped} ` +
    `handle_ok=${count((s) => Number(s.hHandle) > 0)} gameid_matches=${count((s) => String(s.strGameID) === gameid)} ` +
    `loopback_urls=${count((s) => /^https:\/\/steamloopback\.host\/screenshots\//.test(String(s.strUrl)))} ` +
    `http_ok=${statusCounts.ok} http_404=${statusCounts.notFound} http_other=${statusCounts.other} http_none=${statusCounts.none} ` +
    `drawn_from_cache_only=${cachedOnly} api=${captureApiState.screenshots}` +
    (probeDropsAll ? ' (every image failed to load with nothing missing on disk: probe ignored)' : '') +
    (disk === null ? ' (backend check unavailable)' : '');
  // One line per game and outcome: a page view repeats the same answer and must not repeat the line.
  if (toldSummary.get(gameid) !== line) {
    toldSummary.set(gameid, line);
    deps.log(line);
  }
  return kept;
}

/**
 * An event waiting to be pushed, before Steam's own shape is applied.
 *
 * Kept as an explicit tagged union rather than two optional fields so the
 * publish loop below is exhaustive and cannot silently drop a kind.
 */
type PendingEvent =
  | { kind: 'screenshot'; screenshot: SteamScreenshot }
  | { kind: 'clip'; clip: SteamClip };

/** When an event happened, for ordering. Mirrors Steam's own sort keys. */
function timeOf(event: PendingEvent): number {
  return event.kind === 'screenshot' ? event.screenshot.nCreated : event.clip.date_clipped;
}

/**
 * Fill a game's post-game summary and make Steam show it.
 *
 * Events are pushed **oldest first**, matching Steam's own loader: the
 * component walks the list backwards, so insertion order determines the day
 * grouping and separator logic. Getting this backwards silently inverts the
 * page.
 *
 * Returns the number of events published.
 */
export async function publishSummary(appid: number, gameid: string, since = 0): Promise<number> {
  const store = spotlightStore();
  if (!store) return 0;

  let appData: { m_session: GamePlaySession; m_postGameSummary: GamePlaySession | null };
  try {
    appData = store.GetOrCreateAppData(appid);
  } catch (error) {
    logger.warn('Could not reach the spotlight store for', appid, error);
    return 0;
  }

  const collected = await collectAll({ appid, gameid, since });
  const clips = collected.clips;
  const screenshots = await dropDeletedScreenshots(gameid, collected.screenshots);

  // Steam's viewer finds a clicked screenshot in its own cache, not in what the summary was given: put the missing ones there.
  try {
    rememberScreenshots(screenshots);
    const viewerClients = steamQueryClients();
    keepViewerCache(viewerClients);
    const viewer = ensureInViewerCache(screenshots, viewerClients);
    if (screenshots.length > 0) {
      const line =
        `viewer cache: summary=${screenshots.length} missing_before=${viewer.missing} added=${viewer.added} ` +
        `clients_with_cache=${viewer.clients} state=${viewer.state}`;
      if (toldSummary.get(`${gameid}|viewer`) !== line) {
        toldSummary.set(`${gameid}|viewer`, line);
        deps.log(line);
      }
    }
  } catch (error) {
    logger.warn('Could not add screenshots to the viewer cache for', appid, error);
  }

  const events: PendingEvent[] = [
    ...screenshots.map((screenshot): PendingEvent => ({ kind: 'screenshot', screenshot })),
    ...clips.map((clip): PendingEvent => ({ kind: 'clip', clip })),
  ].sort((a, b) => timeOf(a) - timeOf(b));

  const session = appData.m_session;

  try {
    // Replace rather than append: a refresh after a play session must not
    // duplicate everything already on screen.
    session.ClearSessionEvents();

    for (const event of events) {
      if (event.kind === 'screenshot') {
        // Steam's own entry point for a screenshot, so dedupe and ordering
        // behave exactly as they do for a native game.
        session.BAddScreenshotNotification({
          strOperation: 'written',
          unAppID: appid,
          hScreenshot: event.screenshot.hHandle,
          details: event.screenshot,
        });
      } else {
        session.AddClip(event.clip);
      }
    }

    // This is the gate Steam's own updater sets. The component reads
    // `m_postGameSummary`, not `m_session`.
    appData.m_postGameSummary = session.HasSessionEvents() ? session : null;
  } catch (error) {
    logger.warn('Could not publish the summary for', appid, error);
    return 0;
  }

  const clipLine = `summary clips: count=${clips.length} api=${captureApiState.clips}`;
  if (clips.length > 0 || captureApiState.clips !== 'ok') {
    if (toldSummary.get(`${gameid}|clips`) !== clipLine) {
      toldSummary.set(`${gameid}|clips`, clipLine);
      deps.log(clipLine);
    }
  }

  logger.info(
    `Published ${events.length} summary event(s) for ${appid} ` +
      `(${screenshots.length} screenshot(s), ${clips.length} clip(s)).`,
  );
  return events.length;
}

/** Drop a game's summary, so a stale page does not linger. */
export function clearSummary(appid: number): void {
  const store = spotlightStore();
  if (!store) return;

  try {
    const appData = store.GetOrCreateAppData(appid);
    appData.m_session.ClearSessionEvents();
    appData.m_postGameSummary = null;
  } catch {
    // The store may not know this app; nothing to clear.
  }
}
