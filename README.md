# Watchlist Reel

A fast, deliberately simple random-film picker for any public Letterboxd list.
Enter a username (to pick from their watchlist) or paste any list URL — such as
`https://letterboxd.com/official/list/letterboxds-top-500-films` — get one film,
and optionally narrow the reel by genre, rating, runtime, decade, or country.

The goal is to feel like the original one-button picker rather than a dashboard:
one card, one always-visible filter panel, and no film-by-film loading feed.

Built with plain Node.js, HTML, CSS, and JavaScript. No framework, no build step,
and no npm dependencies.

## Quick start

Requires **Node.js 18 or newer** (for the built-in `fetch`).

```bash
npm start
```

Open <http://127.0.0.1:3000>.

The landing page has a **Try the 84-film demo** button, which works without
contacting Letterboxd. To load a real source, enter a public Letterboxd
username or paste a list URL — the field detects which one you meant.

> The source must be public. Private watchlists and lists cannot be read
> without a login.

## Features

- **Any public list or watchlist** — paste a full list URL, or type the bare
  path (`justloay/list/road`), or just a username for their watchlist.

- **One random film at a time** from a shuffled deck that avoids immediate repeats.
- **Genre filters** with multi-select and `Any` / `All` matching.
- **Decade and country filters** as single-select.
- **Rating and runtime sliders**: a minimum Letterboxd rating from `0.1` to
  `5.0` in `0.1` steps, and a maximum runtime that starts at one hour, moves in
  5-minute steps, and can be cleared back to `Any` at the first stop. Films with
  no rating or runtime data stay included.
- **Collapsible filter panel** — click `Filters` to show or hide the whole list, then click a filter name to expand its options.
- **Filter headers are always on the page** — options expand in place, with no pop-up panel.
- **Every page is read**, up to 200 pages, instead of stopping at the first few.
- **Fast first result**: the full list arrives first, then one fully enriched
  random pick is shown while the rest of the metadata loads in the background.
- **Aggregate progress only** (`completed / total`), never a stream of film titles.
- **Readable URLs**: source (username or list id) and filters live in the URL hash.
- **Username and list history** — recent sources appear as suggestions when you
  click the input field; the field itself always starts empty.
- **Keyboard shortcut** while picking: `R` picks another film.
- **English and Arabic**, with an `EN` / `ع` toggle. The first visit follows the
  browser language, and the choice is remembered. Arabic uses full RTL layout,
  translated genre and country names, and an Arabic synopsis. Both languages
  render in the bundled IBM Plex superfamily (Sans Arabic, whose Latin glyphs
  are Plex Sans), so headings, labels and body text keep one voice and one
  type scale instead of switching typefaces. When a film has several countries,
  the card shows the first one followed by “and others”, with the full list in
  the tooltip.
- **Dark and light themes** with a one-click toggle that is remembered between visits.
- **Responsive single-column layout** with reduced-motion support.
- **Two-hour server cache** per username, refreshed in the background. The
  streaming API accepts `?refresh=1` to force a fresh scrape.

## How loading works

There are two phases so the page never feels like it is crawling through films:

1. **Watchlist/list phase** — the server fetches every page of the source
   concurrently and streams page-level progress. This usually takes a few
   seconds. It then renders the app with the complete set of titles, years, and
   links, plus one fully enriched random pick.
2. **Details phase** — film pages are read in the background at bounded
   concurrency to fill in genres, ratings, countries, runtime, synopsis, and
   artwork. Progress is reported as counts only. Picking works immediately;
   filters unlock when the details finish.

When a list is refreshed, film details from the previous cache (up to a week old)
are reused, so only new or changed titles are re-read. A warm refresh therefore
takes roughly as long as the watchlist phase alone.

The practical result is three load states:

| State | What happens | Rough time for 600 films |
| --- | --- | --- |
| Fresh | The two-hour cache is served without any network call. | ~50ms |
| Warm | The source is re-read; details under a week old are reused. | ~2s |
| Cold | No usable details: every film page is read. | ~13s |

Cold loads are rare because **stale caches refresh in the background** — on
startup and every 30 minutes, caches older than two hours are rebuilt one at a
time, so a visitor normally lands on a fresh cache instead of starting the scrape
themselves. Set `PREWARM=0` to disable it.

Film details also stay in memory while the server runs, so films shared by
several users are only read once per process.

Concurrency is tuned with `PAGE_CONCURRENCY` (default `12`) and
`FILM_CONCURRENCY` (default `32`). Sustained rates above roughly 36 film
requests at once start returning HTTP 429 from Letterboxd, so the default stays
at 32. The cache lifetime is `CACHE_TTL_MINUTES` (default `120`).

If one film page fails, that film stays usable with its basic title and year.
If a whole watchlist page fails, the server retries it once sequentially and
reports a partial result rather than silently dropping it.

## How the data is collected

For a live username the server:

1. Reads public watchlist pages at
   `https://letterboxd.com/{username}/watchlist/page/{n}/` — or, for a list,
   `https://letterboxd.com/{owner}/list/{slug}/page/{n}/` — detecting the last
   page from Letterboxd's pagination. List pages use the same poster-grid
   markup as watchlists, so one parser serves both.
2. Reads each film's public Letterboxd page and extracts the JSON-LD `Movie`
   node plus Open Graph metadata.
3. Normalizes rating, runtime, genres, countries, languages, directors, poster,
   backdrop, and synopsis.
4. Streams basics, aggregate progress, and the final dataset to the browser,
   then writes the finished dataset to `data/watchlists/{username}.json` (list
   sources become `{owner}+list+{slug}.json`, a filename form a username can
   never produce).

Requests use a normal browser user agent, bounded concurrency, and small delays
between page batches. Watchlist pages load at up to 12 concurrent requests and
film pages at up to 32. Sustained bursts above roughly 36 film requests at once
start returning HTTP 429, so the defaults stay just under that ceiling.
Letterboxd's rate limits still apply; re-scraping very large lists repeatedly is
not polite.

### Demo data

`data/demo.json` contains 84 films from the public watchlist of Letterboxd user
`dave`, captured as a stable offline dataset. To rebuild it:

```bash
npm run build:demo
# or
node scripts/build-demo.js some-username 3
```

## Shareable filter URLs

The app stores its state in the URL hash. Example:

```text
/#u=demo&g=Drama%2CComedy&m=all&r=4&d=2020&c=USA
```

| Param | Meaning |
| --- | --- |
| `u` | Letterboxd username, a list id as `owner/list/slug`, or `demo` for the built-in dataset |
| `g` | Comma-separated genres |
| `m` | `all` for all-genres matching; omit for any |
| `r` | Minimum rating, from `0.1` to `5` in `0.1` steps |
| `rt` | Maximum runtime in minutes: `60`–`300` in 5-minute steps; `0` (or anything ≤ `55`) means any |
| `d` | Comma-separated release decade start years, such as `2020,2010` |
| `c` | Comma-separated country names |

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Server status and active job count |
| `GET /api/demo` | The demo dataset as JSON |
| `GET /api/watchlist/:source` | A cached source (404 if not cached). `:source` is a username or an encoded list id (`justloay%2Flist%2Froad`) |
| `GET /api/watchlist/:source/stream` | SSE stream with `progress`, `films`, `done`, and `error` events |
| `GET /api/film/:slug` | On-demand metadata for a single film |
| `GET /api/translate?lang=ar&q=…` | English-to-Arabic synopsis translation (cached on disk) |

The stream emits:

- `progress` — `{ phase: "watchlist", page, pagesTotal, filmsFound }` or
  `{ phase: "details", completed, total, failed }`.
- `films` — `{ films, total, pick, detailsComplete: false, ... }`. Every film has
  at least a title, year, and link; `pick` is fully enriched.
- `done` — the complete dataset with `detailsComplete: true`.
- `error` — `{ message, code }`.

## Project structure

```text
server.js               HTTP server, static files, SSE, versioned cache
lib/letterboxd.js       watchlist scraper, JSON-LD parser, enrichment, stats
lib/translate.js        synopsis translation (Google + MyMemory fallback) and cache
scripts/build-demo.js   rebuilds data/demo.json
public/index.html       page structure
public/styles.css       visual design, dark/light themes, RTL layout
public/i18n.js          English/Arabic dictionaries and language switching
public/app.js           client state, filters, deck, URL sync, SSE
public/fonts/           self-hosted IBM Plex Sans Arabic (OFL) and its CSS
data/demo.json          built-in 84-film dataset
data/translations.json  cached Arabic synopses (git-ignored)
data/watchlists/        runtime cache (git-ignored)
capture/orig/           reverse-engineering captures of the original site
```

## Original-site notes

The original site's frontend was captured and inspected before rebuilding. Its
client called a single third-party endpoint that returned one random film and a
status code (`-3` rate limit, `-2` private, `-1` not found, `0` empty, `1`
success). It did not expose enough data for local filtering, so this version
keeps the same one-film-randomizer feel but uses its own scraper and filterable
dataset. The saved original HTML, CSS, and JavaScript are in `capture/orig/` for
reference.

## Limitations

- Public sources only; no Letterboxd login or OAuth.
- Scraping depends on Letterboxd's current HTML and JSON-LD markup. If that
  changes, `lib/letterboxd.js` will need updating.
- Country, genre, rating, and release-year data is only as complete as Letterboxd's metadata.
- The first result appears as soon as the list is ready; filters need the
  background details pass to finish.
- Poster and backdrop images are hot-linked from Letterboxd's CDN.
- Arabic synopses are machine-translated through public endpoints (Google
  translate via two endpoints, with MyMemory as a last resort). They need a
  network connection; when the services are unavailable the English synopsis is
  shown instead and retried automatically with backoff while the film stays on
  screen. Only the currently displayed film is translated.
- The cache is local to the server and resets if the cache files are removed.
- This project is not affiliated with Letterboxd.

## Credits

- Film data and artwork belong to Letterboxd and the respective rights holders.
