import 'dotenv/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

type Movie = { title: string; tmdbId: number; releases?: Array<'cinema' | 'digital'> };
type Show = { title: string; tmdbId: number; seasons?: number[] };
type Config = { region: string; ntfy: { server: string; topic: string }; movies: Movie[]; shows: Show[] };
type Release = { id: string; title: string; kind: 'cinema' | 'digital' | 'episode'; date: string; detail: string; url: string };
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
    const info = await tmdb<{ name?: string; seasons?: Array<{ season_number: number }> }>(`/tv/${show.tmdbId}`);
    const seasons = (show.seasons?.length ? show.seasons : (info.seasons || []).map(s => s.season_number).filter(n => n > 0));
    for (const sn of seasons) {
      const season = await tmdb<{ episodes?: Array<{ id: number; name: string; episode_number: number; air_date?: string }> }>(`/tv/${show.tmdbId}/season/${sn}`);
      for (const ep of season.episodes || []) {
        const date = dateOnly(ep.air_date); if (!date) continue;
        found.push({ id: `episode-${ep.id}-${date}`, title: show.title, kind: 'episode', date, detail: `Season ${sn}, Episode ${ep.episode_number}: ${ep.name}`, url: `https://www.themoviedb.org/tv/${show.tmdbId}/season/${sn}` });
      }
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const limit = new Date(); limit.setUTCDate(limit.getUTCDate() + 7); const max = limit.toISOString().slice(0, 10);
  const upcoming = [...new Map(found.filter(r => r.date >= today && r.date <= max).map(r => [r.id, r])).values()].sort((a,b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const already = new Set(state.notified || []);
  const fresh = upcoming.filter(r => !already.has(r.id));
  if (process.env.SEND_NOTIFICATIONS !== 'false' && config.ntfy?.topic) {
    for (const r of fresh) {
      const response = await fetch(`${(config.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(config.ntfy.topic)}`, { method: 'POST', headers: { Title: `${r.title} - ${r.kind === 'episode' ? 'New episode' : r.kind === 'cinema' ? 'Cinema release' : 'Digital release'}`, Tags: 'movie_camera,calendar', Click: r.url, Priority: 'default' }, body: `${r.detail}\nRelease date: ${r.date}` });
      if (!response.ok) throw new Error(`ntfy notification failed (${response.status})`);
      already.add(r.id);
    }
  }
  const next: State = { checkedAt: new Date().toISOString(), releases: upcoming, notified: [...already].slice(-5000) };
  await writeJson('state.json', next);
  console.log(`Checked ${config.movies?.length || 0} movies and ${config.shows?.length || 0} shows; ${upcoming.length} upcoming releases, ${fresh.length} new alerts.`);
  return next;
}
