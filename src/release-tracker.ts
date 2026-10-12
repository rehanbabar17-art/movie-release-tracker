import 'dotenv/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

type Movie = { title: string; tmdbId: number; releases?: Array<'cinema' | 'digital'> };
type SeasonRequest = number | { seasonNumber?: number; seasonName?: string; number?: number; name?: string };
type Show = { title: string; tmdbId: number; seasons?: SeasonRequest[] };
type Config = { region: string; ntfy: { server: string; topic: string }; movies: Movie[]; shows: Show[] };
type Release = { id: string; title: string; kind: 'cinema' | 'digital' | 'episode' | 'season'; date: string; detail: string; url: string };
type State = { checkedAt?: string; releases: Release[]; notified: string[] };
const PREFIX = 'movie-release-tracker/';
const BUCKET = process.env.B2_BUCKET;
const s3 = new S3Client({ region: 'us-east-1', endpoint: (process.env.B2_ENDPOINT || 'YOUR_B2_ENDPOINT').replace(/\/$/, ''), forcePathStyle: true, credentials: { accessKeyId: process.env.B2_KEY_ID || '', secretAccessKey: process.env.B2_APPLICATION_KEY || '' } });
async function readJson<T>(key: string, fallback?: T): Promise<T> {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + key })); return JSON.parse(await r.Body!.transformToString()) as T; }
  catch (e: any) { if (e?.$metadata?.httpStatusCode === 404 && fallback !== undefined) return fallback; throw e; }
}
async function writeJson(key: string, value: unknown) { await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: PREFIX + key, Body: JSON.stringify(value, null, 2), ContentType: 'application/json' })); }
export async function loadDashboard() { const state = await readJson<State>('state.json', { releases: [], notified: [] }); return { checkedAt: state.checkedAt || null, releases: state.releases || [] }; }
function dateOnly(s?: string) { return s?.slice(0, 10) || ''; }
type TmdbSeason = { season_number: number; name: string; air_date?: string | null };
function normalizeSeasonName(name = '') { return name.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old; }
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
  const ranked = available.map(s => ({ season: s, distance: editDistance(requestedName, normalizeSeasonName(s.name)) }))
    .sort((a, b) => a.distance - b.distance || a.season.season_number - b.season.season_number);
  const best = ranked[0];
  return best && best.distance <= Math.max(2, Math.floor(requestedName.length * 0.25)) ? best.season : undefined;
}
type ReminderStage = 30 | 7 | 3;
export function getReminderStage(releaseDate: string, today = new Date().toISOString().slice(0, 10)): ReminderStage | null {
  const daysUntil = Math.round((Date.parse(`${releaseDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(daysUntil) || daysUntil < 0 || daysUntil > 30) return null;
  if (daysUntil <= 3) return 3;
  if (daysUntil <= 7) return 7;
  return 30;
}
async function tmdb<T>(path: string): Promise<T> {
  const key = process.env.TMDB_API_KEY; if (!key) throw new Error('TMDB_API_KEY is not configured');
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  const isV3ApiKey = /^[a-f0-9]{32}$/i.test(key);
  if (isV3ApiKey) url.searchParams.set('api_key', key);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!isV3ApiKey) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`TMDB returned ${r.status} for ${path}`); return r.json() as Promise<T>;
}
export async function checkReleases() {
  if (!BUCKET || !process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) throw new Error('Configure B2_BUCKET, B2_KEY_ID and B2_APPLICATION_KEY');
  const config = await readJson<Config>('config.json');
  const state = await readJson<State>('state.json', { releases: [], notified: [] });
  const region = (config.region || process.env.RELEASE_REGION || 'US').toUpperCase();
  const found: Release[] = [];
  for (const m of config.movies || []) {
    const data = await tmdb<{ results: Array<{ iso_3166_1: string; release_dates: Array<{ release_date: string; type: number; note?: string }> }> }>(`/movie/${m.tmdbId}/release_dates`);
    const country = data.results.find(x => x.iso_3166_1 === region);
    for (const r of country?.release_dates || []) {
      const kind = ([2, 3].includes(r.type) ? 'cinema' : [4, 7].includes(r.type) ? 'digital' : null) as 'cinema' | 'digital' | null;
      if (!kind || (m.releases?.length && !m.releases.includes(kind))) continue;
      const date = dateOnly(r.release_date); if (!date) continue;
      found.push({ id: `movie-${m.tmdbId}-${kind}-${date}`, title: m.title, kind, date, detail: r.note || (kind === 'cinema' ? `Cinema release · ${region}` : `Digital release · ${region}`), url: `https://www.themoviedb.org/movie/${m.tmdbId}` });
    }
  }
  for (const show of config.shows || []) {
    const info = await tmdb<{ name?: string; seasons?: TmdbSeason[] }>(`/tv/${show.tmdbId}`);
    const available = (info.seasons || []).filter(s => s.season_number > 0);
    const requests: SeasonRequest[] = show.seasons?.length ? show.seasons : available.map(s => s.season_number);
    const canonicalRequests: SeasonRequest[] = [];
    for (const request of requests) {
      const seasonMeta = resolveSeason(request, available);
      if (!seasonMeta) {
        const entered = typeof request === 'number' ? `season ${request}` : (request.seasonName ?? request.name ?? `season ${request.seasonNumber ?? request.number ?? '?'}`);
        console.warn(`Could not match ${show.title} entry "${entered}" to a TMDB season; leaving it unchanged in B2.`);
        canonicalRequests.push(request);
        continue;
      }
      const sn = seasonMeta.season_number;
      canonicalRequests.push({ seasonNumber: sn, seasonName: seasonMeta.name });
      const season = await tmdb<{ name?: string; air_date?: string | null; episodes?: Array<{ id: number; name: string; episode_number: number; air_date?: string }> }>(`/tv/${show.tmdbId}/season/${sn}`);
      const seasonName = season.name || seasonMeta.name || `Season ${sn}`;
      const seasonReleaseDate = dateOnly(season.air_date || seasonMeta.air_date || undefined);
      if (seasonReleaseDate) found.push({ id: `season-${show.tmdbId}-${sn}-${seasonReleaseDate}`, title: show.title, kind: 'season', date: seasonReleaseDate, detail: `Season ${sn}: ${seasonName} premiere`, url: `https://www.themoviedb.org/tv/${show.tmdbId}/season/${sn}` });
      for (const ep of season.episodes || []) {
        const date = dateOnly(ep.air_date); if (!date) continue;
        found.push({ id: `episode-${ep.id}-${date}`, title: show.title, kind: 'episode', date, detail: `${seasonName}, Episode ${ep.episode_number}: ${ep.name}`, url: `https://www.themoviedb.org/tv/${show.tmdbId}/season/${sn}` });
      }
    }
    if (show.seasons?.length) show.seasons = [...new Map(canonicalRequests.map((s, i) => [typeof s === 'number' ? s : s.seasonNumber ?? s.number ?? i, s])).values()];
  }
  // Write back TMDB-canonical season names and numbers alongside other B2 config.
  await writeJson('config.json', config);
  const today = new Date().toISOString().slice(0, 10);
  const dashboardLimit = new Date(); dashboardLimit.setUTCDate(dashboardLimit.getUTCDate() + 30); const dashboardMax = dashboardLimit.toISOString().slice(0, 10);
  const upcoming = [...new Map(found.filter(r => r.date >= today && r.date <= dashboardMax).map(r => [r.id, r])).values()].sort((a,b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const already = new Set(state.notified || []);
  const due = upcoming.map(r => ({ release: r, stage: getReminderStage(r.date, today) }))
    .filter((item): item is { release: Release; stage: ReminderStage } => item.stage !== null)
    .filter(({ release, stage }) => !already.has(`${release.id}:d${stage}`) && !(stage === 7 && already.has(release.id)));
  // Migrate old one-shot IDs so the previous 7-day alert is not repeated as a 7-day stage.
  for (const release of upcoming) if (already.has(release.id)) already.add(`${release.id}:d7`);
  let alertsSent = 0;
  if (process.env.SEND_NOTIFICATIONS !== 'false' && config.ntfy?.topic) {
    for (const { release: r, stage } of due) {
      const response = await fetch(`${(config.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(config.ntfy.topic)}`, { method: 'POST', headers: { Title: `${r.title} - ${stage}-day reminder`, Tags: 'movie_camera,calendar', Click: r.url, Priority: 'default' }, body: `${r.detail}\nRelease date: ${r.date}\nReminder stage: ${stage} days` });
      if (!response.ok) throw new Error(`ntfy notification failed (${response.status})`);
      already.add(`${r.id}:d${stage}`);
      alertsSent++;
    }
  }
  const next: State = { checkedAt: new Date().toISOString(), releases: upcoming, notified: [...already].slice(-5000) };
  await writeJson('state.json', next);
  console.log(`Checked ${config.movies?.length || 0} movies and ${config.shows?.length || 0} shows; ${upcoming.length} upcoming releases, ${alertsSent} reminder-stage alerts sent.`);
  return next;
}
