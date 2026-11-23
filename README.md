# Movie & Episode Release Radar

A private, B2-backed watchlist that checks movie **cinema and digital** release dates plus TV season premieres and episode air dates every day. It tracks **all upcoming releases (including dates announced more than 30 days in advance)**, sends instant [ntfy](https://ntfy.sh) alerts when dates are announced or updated, and provides a dashboard with **All Upcoming**, **Beyond 30 days**, **Next 30 days**, **Next 7 days**, **Next 3 days**, and **Today** views.

## How it works

- GitHub Actions runs daily at 12:00 UTC (GitHub may delay scheduled jobs during busy periods); runs can also be started manually.
- Watchlist and notification settings live in the private Backblaze B2 bucket at `movie-release-tracker/config.json` (and `NTFY_TOPIC` / `NTFY_SERVER` can also be provided via environment variables/secrets as fallbacks).
- The last check, all upcoming releases (including > 30 days), and notification de-duplication state live at `movie-release-tracker/state.json`.
- The workflow fetches catalog data from TMDB, writes all upcoming future releases (including > 30 days) back to B2, and sends ntfy alerts at five milestones:
  1. **Announced / Updated** (immediately when a release date beyond 30 days is newly announced, or when any tracked release date changes)
  2. **30-day reminder** (within 30 days)
  3. **7-day reminder** (within 7 days)
  4. **3-day reminder** (within 3 days)
  5. **Release day** (Today)
- Each release gets at most one alert per stage; if TMDB updates a release date to a new date, a fresh notification is dispatched with the updated date.
- The dashboard runs locally and reads release data from B2; it has no login, so keep it bound to localhost and do not expose it publicly.

## Setup

1. Create a TMDB API access token in your TMDB account and a private Backblaze B2 bucket.
2. In this repository's **Settings → Secrets and variables → Actions**, add `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT` (your B2 account's S3-compatible endpoint), and `TMDB_API_KEY` (TMDB v4 read access token). Optionally add `NTFY_TOPIC` (secret) and `NTFY_SERVER` (variable/secret) if not configured inside B2 `config.json`.
3. Create `movie-release-tracker/config.json` in the private B2 bucket. You can add entries using titles alone; `tmdbId` is optional. A movie entry may look like `{ "title": "Movie title" }`; every tracked movie is automatically configured for both cinema and digital release dates, and its B2 `releases` value is normalized to `["cinema", "digital"]`. A series may look like `{ "title": "Series title", "seasons": [{ "seasonNumber": 2, "seasonName": "Season 2" }] }`. On each check the tracker searches TMDB, chooses the closest title among its search results, and writes the TMDB ID and canonical catalog title back to B2.
4. Run **Actions → Check Releases → Run workflow** once to verify the setup. The daily schedule then keeps it refreshed.

## View releases locally

```bash
npm ci
cp .env.example .env
# Fill in B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT and TMDB_API_KEY in .env
npm run dev
```

Open `http://127.0.0.1:3000`. The dashboard displays **All Upcoming**, **Beyond 30 days**, **Next 30 days**, **Next 7 days**, **Next 3 days**, and **Today**, and includes a **Check Releases Now** action (`POST /api/check`).

## Dates and limitations

- Movie sources are TMDB movie release-date records for the configured country. The checker maps theatrical / limited-theatrical release types to **Cinema**, and digital / streaming release types to **Digital**.
- TV seasons and episodes use TMDB's season/episode `air_date` (falling back to Episode 1's air date for season premieres when TMDB leaves season `air_date` blank).
- The release window uses UTC calendar days. Notification de-duplication records a release ID (including its date) and stage; if a date changes, the new date generates an updated alert.
