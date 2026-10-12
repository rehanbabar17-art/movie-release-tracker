# Movie & Episode Release Radar

A private, B2-backed watchlist that checks movie **cinema and digital** release dates plus TV season episode air dates every day. It sends new-date alerts to a private [ntfy](https://ntfy.sh) topic and provides a dashboard with **Today**, **Next 3 days**, **Next 7 days**, and **Next 30 days** views.

## How it works

- GitHub Actions runs daily at 12:00 UTC (GitHub may delay scheduled jobs during busy periods); runs can also be started manually.
- Watchlist and notification settings live only in the private Backblaze B2 bucket at `movie-release-tracker/config.json`.
- The last check, upcoming releases, and notification de-duplication state live at `movie-release-tracker/state.json`.
- The workflow fetches catalog data from TMDB, writes releases in the next 30 days back to B2, and sends ntfy reminders at three stages: within 30 days, within 7 days, and within 3 days. Each release gets at most one alert per stage; daily checks do not repeat an alert until it reaches the next stage. Older one-shot alert history is treated as the 7-day stage to avoid duplicates.
- The dashboard runs locally and reads release data from B2; it has no login, so keep it bound to localhost and do not expose it publicly.

## Setup

1. Create a TMDB API access token in your TMDB account. For Backblaze B2 use the existing private bucket `YOUR_PRIVATE_B2_BUCKET` and endpoint `YOUR_B2_ENDPOINT` if those are still the bucket details for your other trackers.
2. In this repository's **Settings → Secrets and variables → Actions**, add `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` (value `YOUR_PRIVATE_B2_BUCKET`), `B2_ENDPOINT` (the endpoint above), and `TMDB_API_KEY` (TMDB v4 read access token). These must be added separately to this repository; GitHub does not share repository secrets between repos.
3. Create `movie-release-tracker/config.json` in the private B2 bucket. You can add entries using titles alone; `tmdbId` is optional. A movie entry may look like `{ "title": "Movie title", "releases": ["cinema", "digital"] }`. A series may look like `{ "title": "Series title", "seasons": [{ "seasonNumber": 2, "seasonName": "Season 2" }] }`. On each daily check the tracker searches TMDB, selects the closest exact/near title match, and writes the TMDB ID and canonical catalog title back to B2. Ambiguous exact matches prefer TMDB's more popular result; titles with no close match are logged and skipped without failing the other watchlist entries. For seasons, it matches the number/name, corrects spelling from TMDB, and writes the canonical season name/number back. It also adds the season premiere date and episode air dates to the B2 release state. Omit `seasons` or use an empty list to include all seasons currently listed by TMDB.
4. Run **Actions → Check Releases → Run workflow** once to verify the setup. The daily schedule then keeps it refreshed.

TMDB IDs are filled automatically from the title, so you can maintain the watchlist directly in B2 without looking them up.

## View releases locally

```bash
npm ci
cp .env.example .env
# Fill in B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT and TMDB_API_KEY in .env
npm run dev
```

Open `http://127.0.0.1:3000`. The dashboard filters the saved B2 release list for Today, Next 3 days, Next 7 days, and Next 30 days. `npm run check` runs a check manually. Do not commit `.env`, private B2 config, or state.

## Dates and limitations

- Movie sources are TMDB movie release-date records for the configured country. The checker maps theatrical / limited-theatrical release types to **Cinema**, and digital / streaming release types to **Digital**. TMDB coverage varies by title and country; no date is invented when the source has none.
- TV seasons and episodes use TMDB's season/episode `air_date`. Season premiere dates and individual episode dates are listed separately; these are listed dates, not a promise about a particular streaming platform's local availability time.
- The release window uses UTC calendar days. Notification de-duplication records a release ID and date; if a date changes, the new date can generate a new alert.
- Watchlist contents are not checked into this repository. Keep the ntfy topic private because anyone who knows a public ntfy topic can subscribe to it.
