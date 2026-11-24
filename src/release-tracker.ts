import 'dotenv/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

type Movie = { title?: string; name?: string; tmdbId?: number | null; tmdb_id?: number | null; releases?: Array<'cinema' | 'digital'> };
type SeasonRequest = number | { seasonNumber?: number; seasonName?: string; number?: number; name?: string };
type Show = { title?: string; name?: string; tmdbId?: number | null; tmdb_id?: number | null; seasons?: SeasonRequest[]; seasonNumber?: number; seasonName?: string };
type Config = { region: string; ntfy?: { server?: string; topic?: string }; movies: Movie[]; shows: Show[] };
type Release = { id: string; title: string; kind: 'cinema' | 'digital' | 'episode' | 'season'; date: string; detail: string; url: string };
type TrackedStatus = {
  title: string;
  kind: 'movie' | 'tv';
  tmdbId: number | null;
  upcomingCount: number;
  latestDate: string | null;
  status: string;
};
type State = { checkedAt?: string; releases: Release[]; notified: string[]; tracked?: TrackedStatus[] };

const PREFIX = 'movie-release-tracker/';
const BUCKET = process.env.B2_BUCKET;
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.B2_ENDPOINT?.replace(/\/$/, ''),
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.B2_KEY_ID || '', secretAccessKey: process.env.B2_APPLICATION_KEY || '' }
});

async function readJson<T>(key: string, fallback?: T): Promise<T> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + key }));
    return JSON.parse(await r.Body!.transformToString()) as T;
  } catch (e: any) {
    if ((e?.$metadata?.httpStatusCode === 404 || e?.name === 'NoSuchKey') && fallback !== undefined) return fallback;
    throw e;
  }
}

async function writeJson(key: string, value: unknown) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: PREFIX + key, Body: JSON.stringify(value, null, 2), ContentType: 'application/json' }));
}

export async function loadDashboard() {
  const state = await readJson<State>('state.json', { releases: [], notified: [], tracked: [] });
  return { checkedAt: state.checkedAt || null, releases: state.releases || [], tracked: state.tracked || [] };
}

function dateOnly(s?: string | null) {
  const value = s?.slice(0, 10) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function releaseBaseKey(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function sanitizeHeader(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '-')
    .trim();
}

type TmdbSeason = { season_number: number; name: string; air_date?: string | null };

function normalizeSeasonName(name = '') {
  return name.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return row[b.length];
}

export function resolveSeason(request: SeasonRequest, available: TmdbSeason[]): TmdbSeason | undefined {
  const requestedNumber = typeof request === 'number' ? request : request.seasonNumber ?? request.number;
  const requestedName = normalizeSeasonName(typeof request === 'number' ? '' : request.seasonName ?? request.name ?? '');
  const numberMatch = available.find(s => s.season_number === requestedNumber);
  if (!requestedName) return numberMatch;
  const exactName = available.find(s => normalizeSeasonName(s.name) === requestedName);
  if (exactName) return exactName;
  if (numberMatch) return numberMatch;
  const ranked = available
    .map(s => ({ season: s, distance: editDistance(requestedName, normalizeSeasonName(s.name)) }))
    .sort((a, b) => a.distance - b.distance || a.season.season_number - b.season.season_number);
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(requestedName.length * 0.25)) ? best.season : undefined;
}

function normalizedTitle(title = '') {
  return title.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripLeadingArticle(title = '') {
  return normalizedTitle(title).replace(/^(the|a|an)\s+/, '').trim();
}

type SearchCandidate = { id: number; title?: string; original_title?: string; name?: string; original_name?: string; popularity?: number };

export function chooseTitleMatch<T extends SearchCandidate>(query: string, results: T[]): T | undefined {
  const q = normalizedTitle(query);
  if (!q) return undefined;
  const exact = results.filter(item => [item.title, item.original_title, item.name, item.original_name].some(value => normalizedTitle(value || '') === q));
  if (exact.length) return exact.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];

  const qNoArticle = stripLeadingArticle(query);
  if (qNoArticle) {
    const articleExact = results.filter(item =>
      [item.title, item.original_title, item.name, item.original_name].some(value => stripLeadingArticle(value || '') === qNoArticle)
    );
    if (articleExact.length) return articleExact.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
  }

  const ranked = results
    .map(item => {
      const names = [item.title, item.original_title, item.name, item.original_name].filter(Boolean).map(value => stripLeadingArticle(value!));
      return { item, distance: Math.min(...names.map(name => editDistance(qNoArticle || q, name))) };
    })
    .sort((a, b) => a.distance - b.distance || (b.item.popularity || 0) - (a.item.popularity || 0));
  return ranked[0]?.item;
}

async function ensureCatalogId(kind: 'movie' | 'tv', item: Movie | Show): Promise<number | undefined> {
  const enteredTitle = (item.title || item.name || '').trim();
  const existing = item.tmdbId ?? item.tmdb_id;
  if (Number.isInteger(existing) && (existing as number) > 0) {
    item.tmdbId = existing as number;
    delete item.tmdb_id;
    if (!item.title && item.name) item.title = item.name;
    return existing as number;
  }
  if (!enteredTitle) {
    console.warn(`Skipping a ${kind} entry without a title or TMDB ID.`);
    return undefined;
  }
  const searchQueries = [enteredTitle];
  const withoutArticle = enteredTitle.replace(/^(the|a|an)\s+/i, '').trim();
  if (withoutArticle && withoutArticle.toLowerCase() !== enteredTitle.toLowerCase()) {
    searchQueries.push(withoutArticle);
  }
  const allResults: SearchCandidate[] = [];
  for (const q of searchQueries) {
    const result = kind === 'movie'
      ? await tmdb<{ results: SearchCandidate[] }>(`/search/movie?query=${encodeURIComponent(q)}`)
      : await tmdb<{ results: SearchCandidate[] }>(`/search/tv?query=${encodeURIComponent(q)}`);
    for (const r of result.results || []) {
      if (!allResults.some(x => x.id === r.id)) allResults.push(r);
    }
  }
  const candidate = chooseTitleMatch(enteredTitle, allResults);
  if (!candidate) {
    console.warn(`TMDB returned no search results for one ${kind} entry; skipping it this run.`);
    return undefined;
  }
  item.tmdbId = candidate.id;
  item.title = (kind === 'movie' ? candidate.title || candidate.original_title : candidate.name || candidate.original_name) || enteredTitle;
  delete item.name;
  delete item.tmdb_id;
  console.log(`Linked one ${kind} entry to a TMDB catalog record; saving the match to B2.`);
  return candidate.id;
}

export type ReminderStage = 'announced' | 30 | 7 | 3 | 0;

export function getReminderStage(releaseDate: string, today = new Date().toISOString().slice(0, 10)): ReminderStage | null {
  const daysUntil = Math.round((Date.parse(`${releaseDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(daysUntil) || daysUntil < 0) return null;
  if (daysUntil === 0) return 0;
  if (daysUntil <= 3) return 3;
  if (daysUntil <= 7) return 7;
  if (daysUntil <= 30) return 30;
  return 'announced';
}

async function tmdb<T>(path: string): Promise<T> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY is not configured');
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  const isV3ApiKey = /^[a-f0-9]{32}$/i.test(key);
  if (isV3ApiKey) url.searchParams.set('api_key', key);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!isV3ApiKey) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`TMDB returned ${r.status} for ${path}`);
  return r.json() as Promise<T>;
}

type CountryReleaseBucket = {
  iso_3166_1: string;
  release_dates: Array<{ release_date: string; type: number; note?: string }>;
};

function mapMovieReleaseType(type: number, includePremiere = false): 'cinema' | 'digital' | null {
  if ([2, 3].includes(type)) return 'cinema';
  if ([4, 7].includes(type)) return 'digital';
  if (includePremiere && type === 1) return 'cinema';
  return null;
}

function collectMovieEntries(
  movieId: number,
  movieTitle: string,
  region: string,
  today: string,
  allowedKinds: Array<'cinema' | 'digital'>,
  movieInfo: { title?: string; release_date?: string | null },
  releaseBuckets: CountryReleaseBucket[]
): { releases: Release[]; latestDate: string | null; upcomingCount: number } {
  const orderedCountries: CountryReleaseBucket[] = [];
  const preferred = [region, 'US'];
  for (const code of preferred) {
    const match = releaseBuckets.find(x => x.iso_3166_1 === code);
    if (match && !orderedCountries.includes(match)) orderedCountries.push(match);
  }
  for (const bucket of releaseBuckets) {
    if (!orderedCountries.includes(bucket)) orderedCountries.push(bucket);
  }

  const extractFromBucket = (bucket: CountryReleaseBucket, includePremiere: boolean) => {
    const items: Release[] = [];
    for (const r of bucket.release_dates || []) {
      const kind = mapMovieReleaseType(r.type, includePremiere);
      if (!kind || (allowedKinds.length && !allowedKinds.includes(kind))) continue;
      const date = dateOnly(r.release_date);
      if (!date) continue;
      items.push({
        id: `movie-${movieId}-${kind}-${date}`,
        title: movieTitle,
        kind,
        date,
        detail:
          r.note ||
          (r.type === 1
            ? `Premiere release · ${bucket.iso_3166_1}`
            : kind === 'cinema'
            ? `Cinema release · ${bucket.iso_3166_1}`
            : `Digital release · ${bucket.iso_3166_1}`),
        url: `https://www.themoviedb.org/movie/${movieId}`
      });
    }
    return items;
  };

  let picked: Release[] = [];
  // 1. Prefer the highest-priority country with upcoming cinema/digital dates (even >30 days out)
  for (const bucket of orderedCountries) {
    const items = extractFromBucket(bucket, false);
    if (items.some(i => i.date >= today)) {
      picked = items;
      break;
    }
  }
  // 2. Fallback: check Premiere (type 1) upcoming dates across ordered countries
  if (!picked.some(i => i.date >= today)) {
    for (const bucket of orderedCountries) {
      const items = extractFromBucket(bucket, true);
      if (items.some(i => i.date >= today)) {
        picked = items;
        break;
      }
    }
  }
  // 3. Fallback: if no upcoming dates yet in release_dates, keep historical cinema/digital from preferred country
  if (!picked.length) {
    for (const bucket of orderedCountries) {
      const items = extractFromBucket(bucket, false);
      if (items.length) {
        picked = items;
        break;
      }
    }
  }
  // 4. Fallback: use TMDB movie's primary release_date if no upcoming release_dates entry exists yet
  const primaryDate = dateOnly(movieInfo.release_date);
  if (primaryDate && (!picked.some(i => i.date >= today) || (primaryDate >= today && !picked.some(i => i.date === primaryDate)))) {
    picked.push({
      id: `movie-${movieId}-cinema-${primaryDate}`,
      title: movieTitle,
      kind: 'cinema',
      date: primaryDate,
      detail: 'Announced theatrical release',
      url: `https://www.themoviedb.org/movie/${movieId}`
    });
  }

  const deduped = [...new Map(picked.map(r => [r.id, r])).values()];
  let latestDate: string | null = null;
  let upcomingCount = 0;
  for (const item of deduped) {
    if (!latestDate || item.date > latestDate) latestDate = item.date;
    if (item.date >= today) upcomingCount++;
  }
  return { releases: deduped, latestDate, upcomingCount };
}

async function syncMoviesJsonIfPresent(upcoming: Release[], notifiedSet: Set<string>, tracked: TrackedStatus[], checkedAt: string) {
  try {
    const store = await readJson<any>('movies.json', null);
    if (!store || !Array.isArray(store.items)) return;

    let changed = false;
    for (const item of store.items) {
      const isMovie = item.type === 'movie' && (item.seasonNumber === null || item.seasonNumber === undefined);
      const tmdbId = item.tmdbId ? Number(item.tmdbId) : null;
      const titleLower = (item.title || '').toLowerCase();

      const matchingReleases = upcoming
        .filter(r => {
          if (tmdbId && r.url && r.url.includes(`/${isMovie ? 'movie' : 'tv'}/${tmdbId}`)) return true;
          return r.title.toLowerCase() === titleLower;
        })
        .sort((a, b) => {
          const d = a.date.localeCompare(b.date);
          if (d !== 0) return d;
          const rank = (k: Release['kind']) => (k === 'season' || k === 'cinema' ? 0 : k === 'digital' ? 1 : 2);
          return rank(a.kind) - rank(b.kind);
        });

      const primary = matchingReleases[0];
      const diag = tracked.find(
        t => (tmdbId && t.tmdbId === tmdbId && t.kind === (isMovie ? 'movie' : 'tv')) || t.title.toLowerCase() === titleLower
      );

      if (primary) {
        const alertStages = {
          announced: notifiedSet.has(`${primary.id}:announced`),
          d30: notifiedSet.has(`${primary.id}:d30`),
          d7: notifiedSet.has(`${primary.id}:d7`) || notifiedSet.has(primary.id),
          d3: notifiedSet.has(`${primary.id}:d3`),
          d0: notifiedSet.has(`${primary.id}:d0`)
        };
        if (
          item.releaseDate !== primary.date ||
          item.detail !== primary.detail ||
          item.status !== 'confirmed' ||
          JSON.stringify(item.alertStages || {}) !== JSON.stringify(alertStages)
        ) {
          item.releaseDate = primary.date;
          item.status = 'confirmed';
          item.detail = primary.detail;
          item.url = primary.url;
          item.alertStages = alertStages;
          item.updatedAt = checkedAt;
          changed = true;
        }
      }

      if (diag) {
        if (item.trackedStatus !== diag.status || item.latestKnownDate !== diag.latestDate || item.upcomingCount !== diag.upcomingCount) {
          item.trackedStatus = diag.status;
          item.latestKnownDate = diag.latestDate;
          item.upcomingCount = diag.upcomingCount;
          changed = true;
        }
      }
    }

    if (changed) {
      if (store.config) store.config.lastAudit = checkedAt;
      await writeJson('movies.json', store);
      console.log('Synchronized updated release dates to B2 movies.json.');
    }
  } catch (err) {
    console.warn('Skipped optional B2 movies.json sync:', err instanceof Error ? err.message : err);
  }
}

export async function checkReleases() {
  if (!BUCKET || !process.env.B2_ENDPOINT || !process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) {
    throw new Error('Configure B2_BUCKET, B2_ENDPOINT, B2_KEY_ID and B2_APPLICATION_KEY');
  }
  const config = await readJson<Config>('config.json');
  const state = await readJson<State>('state.json', { releases: [], notified: [] });
  const region = (config.region || process.env.RELEASE_REGION || 'US').toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const found: Release[] = [];
  const tracked: TrackedStatus[] = [];

  for (const [idx, m] of (config.movies || []).entries()) {
    // User preference: every tracked movie watches both theatrical and digital dates.
    m.releases = ['cinema', 'digital'];
    const movieId = await ensureCatalogId('movie', m);
    if (!movieId) {
      tracked.push({
        title: m.title || m.name || 'Unknown movie',
        kind: 'movie',
        tmdbId: null,
        upcomingCount: 0,
        latestDate: null,
        status: 'No TMDB match found'
      });
      continue;
    }
    const [movieInfo, releaseDatesData] = await Promise.all([
      tmdb<{ title?: string; release_date?: string | null }>(`/movie/${movieId}`),
      tmdb<{ results: CountryReleaseBucket[] }>(`/movie/${movieId}/release_dates`)
    ]);
    if (movieInfo.title) m.title = movieInfo.title;
    const movieTitle = m.title || m.name || `Movie ${movieId}`;
    const { releases: movieReleases, latestDate: movieLatest, upcomingCount: movieUpcoming } = collectMovieEntries(
      movieId,
      movieTitle,
      region,
      today,
      m.releases,
      movieInfo,
      releaseDatesData.results || []
    );
    found.push(...movieReleases);
    console.log(`Movie #${idx + 1}: ${movieUpcoming} upcoming date(s), latest ${movieLatest || 'none'}.`);
    tracked.push({
      title: movieTitle,
      kind: 'movie',
      tmdbId: movieId,
      upcomingCount: movieUpcoming,
      latestDate: movieLatest,
      status: movieUpcoming > 0 ? `${movieUpcoming} upcoming date(s)` : movieLatest ? `Latest date ${movieLatest} (past)` : 'No release date listed on TMDB yet'
    });
  }

  for (const [idx, show] of (config.shows || []).entries()) {
    const showId = await ensureCatalogId('tv', show);
    if (!showId) {
      tracked.push({
        title: show.title || show.name || 'Unknown series',
        kind: 'tv',
        tmdbId: null,
        upcomingCount: 0,
        latestDate: null,
        status: 'No TMDB match found'
      });
      continue;
    }
    const info = await tmdb<{
      name?: string;
      seasons?: TmdbSeason[];
      next_episode_to_air?: { id: number; name?: string; season_number: number; episode_number: number; air_date?: string | null } | null;
    }>(`/tv/${showId}`);
    if (info.name) show.title = info.name;
    const showTitle = show.title || show.name || `Series ${showId}`;
    // Include Season 0 (Specials) as well as regular seasons.
    const available = (info.seasons || []).filter(s => s.season_number >= 0);
    const requests: SeasonRequest[] = show.seasons?.length
      ? show.seasons
      : show.seasonNumber
      ? [{ seasonNumber: show.seasonNumber, seasonName: show.seasonName || `Season ${show.seasonNumber}` }]
      : available.map(s => s.season_number);
    const canonicalRequests: SeasonRequest[] = [];
    const checkedSeasonNumbers = new Set<number>();
    let showUpcoming = 0;
    let showLatest: string | null = null;

    const recordDate = (d: string) => {
      if (!showLatest || d > showLatest) showLatest = d;
      if (d >= today) showUpcoming++;
    };

    const collectSeason = async (sn: number, fallbackName?: string, fallbackAirDate?: string | null) => {
      const season = await tmdb<{ name?: string; air_date?: string | null; episodes?: Array<{ id: number; name: string; episode_number: number; air_date?: string }> }>(`/tv/${showId}/season/${sn}`);
      const seasonName = season.name || fallbackName || (sn === 0 ? 'Specials' : `Season ${sn}`);
      const firstEpisodeDate = (season.episodes || [])
        .map(ep => dateOnly(ep.air_date))
        .filter(Boolean)
        .sort()[0];
      const seasonReleaseDate = dateOnly(season.air_date || fallbackAirDate || firstEpisodeDate || undefined);
      if (seasonReleaseDate) {
        recordDate(seasonReleaseDate);
        found.push({
          id: `season-${showId}-${sn}-${seasonReleaseDate}`,
          title: showTitle,
          kind: 'season',
          date: seasonReleaseDate,
          detail: sn === 0 ? `Specials: ${seasonName} premiere` : `Season ${sn}: ${seasonName} premiere`,
          url: `https://www.themoviedb.org/tv/${showId}/season/${sn}`
        });
      }
      for (const ep of season.episodes || []) {
        const date = dateOnly(ep.air_date);
        if (!date) continue;
        recordDate(date);
        found.push({
          id: `episode-${ep.id}-${date}`,
          title: showTitle,
          kind: 'episode',
          date,
          detail: `${seasonName}, Episode ${ep.episode_number}: ${ep.name}`,
          url: `https://www.themoviedb.org/tv/${showId}/season/${sn}`
        });
      }
      return seasonName;
    };

    for (const request of requests) {
      const seasonMeta = resolveSeason(request, available);
      if (!seasonMeta) {
        console.warn('Could not match one requested season to TMDB; leaving that season entry unchanged in B2.');
        canonicalRequests.push(request);
        continue;
      }
      const sn = seasonMeta.season_number;
      checkedSeasonNumbers.add(sn);
      canonicalRequests.push({ seasonNumber: sn, seasonName: seasonMeta.name });
      await collectSeason(sn, seasonMeta.name, seasonMeta.air_date);
    }

    // A show-level watch also alerts for future premieres, specials, and episodes of all listed seasons.
    for (const seasonMeta of available) {
      if (checkedSeasonNumbers.has(seasonMeta.season_number)) continue;
      await collectSeason(seasonMeta.season_number, seasonMeta.name, seasonMeta.air_date);
    }

    // Fallback: if TMDB reports next_episode_to_air before season details update, capture it.
    if (info.next_episode_to_air?.air_date) {
      const nextEp = info.next_episode_to_air;
      const date = dateOnly(nextEp.air_date);
      const epId = `episode-${nextEp.id}-${date}`;
      if (date && !found.some(r => r.id === epId)) {
        recordDate(date);
        found.push({
          id: epId,
          title: showTitle,
          kind: 'episode',
          date,
          detail: `Season ${nextEp.season_number}, Episode ${nextEp.episode_number}: ${nextEp.name || 'Upcoming episode'}`,
          url: `https://www.themoviedb.org/tv/${showId}/season/${nextEp.season_number}`
        });
      }
    }

    if (show.seasons?.length) {
      show.seasons = [...new Map(canonicalRequests.map((s, i) => [typeof s === 'number' ? s : s.seasonNumber ?? s.number ?? i, s])).values()];
    }

    console.log(`Show #${idx + 1}: ${available.length} TMDB season(s) checked, ${showUpcoming} upcoming date(s), latest ${showLatest || 'none'}.`);
    tracked.push({
      title: showTitle,
      kind: 'tv',
      tmdbId: showId,
      upcomingCount: showUpcoming,
      latestDate: showLatest,
      status: showUpcoming > 0 ? `${showUpcoming} upcoming date(s)` : showLatest ? `Latest date ${showLatest} (past)` : 'No air date listed on TMDB yet'
    });
  }

  // Write back TMDB-canonical season names and numbers alongside other B2 config.
  await writeJson('config.json', config);

  // Keep all future releases (including > 30 days) so announced dates are tracked and shown in the app,
  // alerted immediately when announced or updated, and reminded again at 30, 7, 3, and 0 (Today) days.
  const upcoming = [...new Map(found.filter(r => r.date >= today).map(r => [r.id, r])).values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  const previousByBase = new Map<string, Release>();
  for (const prev of state.releases || []) {
    previousByBase.set(releaseBaseKey(prev.id), prev);
  }

  const already = new Set(state.notified || []);
  // Migrate old one-shot IDs so the previous 7-day alert is not repeated as a 7-day stage.
  for (const release of upcoming) if (already.has(release.id)) already.add(`${release.id}:d7`);

  const stageKey = (id: string, stage: ReminderStage) =>
    stage === 'announced' ? `${id}:announced` : `${id}:d${stage}`;

  const due = upcoming
    .map(r => ({ release: r, stage: getReminderStage(r.date, today) }))
    .filter((item): item is { release: Release; stage: ReminderStage } => item.stage !== null)
    .filter(({ release, stage }) => !already.has(stageKey(release.id, stage)));

  const ntfyTopic = (config.ntfy?.topic || process.env.NTFY_TOPIC || '').trim();
  const ntfyServer = (config.ntfy?.server || process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

  let alertsSent = 0;
  if (process.env.SEND_NOTIFICATIONS !== 'false') {
    if (!ntfyTopic) {
      console.warn('ntfy notifications skipped: configure ntfy.topic in B2 config.json or NTFY_TOPIC env var.');
    } else {
      for (const { release: r, stage } of due) {
        const prev = previousByBase.get(releaseBaseKey(r.id));
        const isDateUpdated = Boolean(prev && prev.date !== r.date);
        const daysUntil = Math.round((Date.parse(`${r.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

        const title =
          isDateUpdated
            ? `${r.title} - Release Date Updated!`
            : stage === 'announced'
            ? `${r.title} - Release Date Announced!`
            : stage === 0
            ? `${r.title} - Releasing Today!`
            : `${r.title} - ${stage}-day reminder`;

        const body =
          isDateUpdated
            ? `${r.detail}\nPrevious date: ${prev!.date}\nNew release date: ${r.date} (in ${daysUntil} days)`
            : stage === 'announced'
            ? `${r.detail}\nAnnounced release date: ${r.date} (in ${daysUntil} days)\nYou will also receive reminders at 30, 7, and 3 days, plus on release day.`
            : stage === 0
            ? `${r.detail}\nRelease date: ${r.date} (Today!)`
            : `${r.detail}\nRelease date: ${r.date}\nReminder stage: ${stage} days`;

        const tags =
          stage === 0
            ? 'popcorn,tada,clapper'
            : isDateUpdated || stage === 'announced'
            ? 'loudspeaker,calendar'
            : 'movie_camera,calendar';

        const response = await fetch(`${ntfyServer}/${encodeURIComponent(ntfyTopic)}`, {
          method: 'POST',
          headers: {
            Title: sanitizeHeader(title),
            Tags: tags,
            Click: r.url,
            Priority: stage === 0 ? 'high' : 'default'
          },
          body
        });
        if (!response.ok) throw new Error(`ntfy notification failed (${response.status})`);
        already.add(stageKey(r.id, stage));
        alertsSent++;
      }
    }
  }

  const checkedAt = new Date().toISOString();
  const next: State = { checkedAt, releases: upcoming, notified: [...already].slice(-5000), tracked };
  await writeJson('state.json', next);
  await syncMoviesJsonIfPresent(upcoming, already, tracked, checkedAt);
  console.log(`Checked ${config.movies?.length || 0} movies and ${config.shows?.length || 0} shows; ${upcoming.length} upcoming releases, ${alertsSent} reminder-stage alerts sent.`);
  return next;
}
