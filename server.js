'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const {
  BASE,
  scrapeWatchlist,
  scrapeList,
  enrichFilms,
  fetchFilmDetails,
  createThrottleGate,
  computeStats,
  basicFilmFromItem,
  isValidUsername,
  isValidListSlug,
} = require('./lib/letterboxd');
const { translate } = require('./lib/translate');
const {
  searchMovie,
  pickResult,
  tmdbFetchJson,
  filmFromTmdb,
} = require('./lib/tmdb');

const PORT = Number(process.env.PORT || 3000);
// Render runs the app inside a container and requires binding to all
// interfaces (0.0.0.0) so its port scan can find the service. Locally
// we keep 127.0.0.1. Render injects RENDER/RENDER_EXTERNAL_URL into
// every web service; an explicit HOST still wins (see render.yaml).
const IS_RENDER =
  process.env.RENDER === 'true' || Boolean(process.env.RENDER_EXTERNAL_URL);
const HOST = process.env.HOST || (IS_RENDER ? '0.0.0.0' : '127.0.0.1');

// A stray rejection or error must not take the whole service down — on
// small hosts (Render free plan) a crash drops every open SSE stream and
// sends users back to square one. Log and keep serving.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'data', 'watchlists');
const DEMO_PATH = path.join(ROOT, 'data', 'demo.json');
// Serve a cache as-is for two hours so a newly added film shows up within
// roughly two hours (plus the prewarm sweep), without a manual refresh button.
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES) > 0 ? Number(process.env.CACHE_TTL_MINUTES) : 120;
const CACHE_TTL_MS = Math.max(5, CACHE_TTL_MINUTES) * 60 * 1000;
// Film details can be reused from an older cache file, but only for a week so
// ratings and metadata do not drift forever on lists that are never re-read.
const SEED_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const CACHE_VERSION = 3;
// Concurrency vs. memory: every in-flight film page holds 1–2 MB of HTML
// (plus undici buffers and parse temporaries). 32 concurrent pages peaks
// well past the ~256 MB V8 heap allowed inside Render's free 512 MB
// container, and the instance dies mid-enrichment ("JavaScript heap out
// of memory"). Small hosts get small batches; local machines keep the
// fast defaults. Override with env vars either way.
// With the sliced-string leak fixed (cloneFlat above), retention is now
// kilobytes per film, so concurrency is bounded by transient fetch
// buffers only (~4 MB per in-flight page). 16 on the free container
// peaks around 100-130 MB of the ~256 MB V8 heap while roughly halving
// the details phase; local machines can afford the original 32.
const MEM_DEFAULTS = IS_RENDER ? { page: 6, film: 16 } : { page: 12, film: 32 };
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.PAGE_CONCURRENCY || MEM_DEFAULTS.page));
const FILM_CONCURRENCY = Math.max(1, Number(process.env.FILM_CONCURRENCY || MEM_DEFAULTS.film));

console.log(
  `[boot] render=${IS_RENDER} page=${PAGE_CONCURRENCY} film=${FILM_CONCURRENCY} heap=${Math.round(
    process.memoryUsage().heapUsed / 1e6
  )}MB node=${process.version}`
);
// Refresh stale caches in the background instead of making the next visitor
// wait for a cold/warm rebuild. Set PREWARM=0 to disable.
const PREWARM = process.env.PREWARM !== '0';
const PREWARM_INTERVAL_MS = 1000 * 60 * 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const jobs = new Map();
let prewarming = false;

// ── Film cache + one global read gate ───────────────────────────
// Every film read — enrichment workers, the headline pick, /api/film and the
// translation route — flows through one bounded path: a single adaptive gate
// spans all concurrent jobs (N simultaneous cold loads can no longer multiply
// Letterboxd traffic), identical in-flight reads share one promise instead of
// doubling the hit, and fully read films are cached with a timestamp the
// moment they complete rather than when the job finishes.
const FILM_CACHE_MAX = Math.max(10, Number(process.env.FILM_CACHE_MAX) || 4000);
const FILM_CACHE_TTL_MS = SEED_MAX_AGE_MS; // same freshness rule as job seeding
const filmCache = new Map(); // slug -> { film, fetchedAt }, LRU by insertion order

// One adaptive gate for every film page read in this process.
const filmGate = createThrottleGate({
  start: FILM_CONCURRENCY,
  max: Math.max(FILM_CONCURRENCY, Math.min(FILM_CONCURRENCY * 2, 48)),
});

const detailInFlight = new Map();

function filmCacheGet(slug) {
  const entry = filmCache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > FILM_CACHE_TTL_MS) {
    filmCache.delete(slug);
    return null;
  }
  // Refresh recency so the LRU eviction keeps hot films.
  filmCache.delete(slug);
  filmCache.set(slug, entry);
  return entry.film;
}

function filmCacheSet(slug, film) {
  if (!film?.metaComplete) return;
  filmCache.delete(slug);
  filmCache.set(slug, { film, fetchedAt: Date.now() });
  while (filmCache.size > FILM_CACHE_MAX) {
    filmCache.delete(filmCache.keys().next().value);
  }
}

// Dedupe-only read for enrichment workers: the gate slot is already held by
// the caller, but identical in-flight reads still share one promise and every
// completed film lands in the cache immediately (not when the job finishes).
// Failed reads stay uncached, so a throttled film self-heals on a later load.
function cachedFilmDetails(item, options = {}) {
  const hit = filmCacheGet(item.slug);
  if (hit) return Promise.resolve(hit);
  const existing = detailInFlight.get(item.slug);
  if (existing) return existing;
  const promise = fetchFilmDetails(item, options)
    .then((film) => {
      filmCacheSet(item.slug, film);
      return film;
    })
    .finally(() => {
      detailInFlight.delete(item.slug);
    });
  detailInFlight.set(item.slug, promise);
  return promise;
}

// Public read path (the pick, /api/film, /api/translate): bounded by the
// shared gate; `priority` queue-jumps the headline pick past an enrichment
// burst without going unbounded.
async function getFilmDetails(item, options = {}) {
  const hit = filmCacheGet(item.slug);
  if (hit) return hit;
  const existing = detailInFlight.get(item.slug);
  if (existing) return existing;
  const promise = (async () => {
    await filmGate.acquire(Boolean(options.priority));
    try {
      const film = await fetchFilmDetails(item, options);
      filmGate.success();
      filmCacheSet(item.slug, film);
      return film;
    } catch (error) {
      if (error?.status === 403 || error?.status === 429) filmGate.throttle();
      throw error;
    } finally {
      filmGate.release();
    }
  })();
  detailInFlight.set(item.slug, promise);
  promise
    .finally(() => {
      detailInFlight.delete(item.slug);
    })
    .catch(() => {});
  return promise;
}

// ── TMDB bulk enrichment (official API, keyed) ──────────────────
// With TMDB_API_KEY set, film details come from TMDB (Arabic synopses are
// human-written there) instead of scraping every Letterboxd film page. The
// lists themselves still come from Letterboxd, and the on-screen card
// upgrades to the real Letterboxd community rating through the lazy
// lbRating fetch below. Without the key every path here is inert and the
// server behaves exactly as before.
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB_CONCURRENCY = Math.max(1, Number(process.env.TMDB_CONCURRENCY) || 10);
const tmdbInFlight = new Map();

// One TMDB film: search by title+year, confidence-check the match, fetch
// details in Arabic (English fallback when TMDB has no Arabic synopsis).
// A confident miss returns null so the caller can scrape Letterboxd for that
// film instead — a wrong match never reaches the user.
async function getTmdbFilm(item) {
  const title = item.title || item.fallbackTitle || '';
  const year = item.year || item.fallbackYear || null;
  const existing = tmdbInFlight.get(item.slug);
  if (existing) return existing;
  const promise = (async () => {
    const results = await searchMovie(title, year, TMDB_KEY);
    const chosen = pickResult(results, { title, year });
    if (!chosen) return null;
    const details = await tmdbFetchJson(
      `/movie/${chosen.id}`,
      { language: 'ar', append_to_response: 'credits' },
      TMDB_KEY
    );
    const film = filmFromTmdb(item.slug, title, year, details);
    if (!film.overview) {
      const english = await tmdbFetchJson(`/movie/${chosen.id}`, { language: 'en-US' }, TMDB_KEY);
      film.overview = (english.overview || '').trim();
      film.overviewLang = film.overview ? 'en' : '';
    }
    filmCacheSet(item.slug, film);
    return film;
  })();
  tmdbInFlight.set(item.slug, promise);
  promise
    .finally(() => {
      tmdbInFlight.delete(item.slug);
    })
    .catch(() => {});
  return promise;
}

// Bulk pass with the same contract as enrichFilms: array of film objects in
// input order plus identical progress events. Cached films (this process or
// the seeded previous payload) cost zero requests; confident TMDB misses fall
// back to the Letterboxd scrape through the shared read path.
async function tmdbEnrich(items, { onProgress, initial = new Map() } = {}) {
  let completed = 0;
  let failed = 0;
  let lastReportAt = 0;
  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReportAt < 350) return;
    lastReportAt = now;
    onProgress({ phase: 'details', completed, total: items.length, failed, limit: TMDB_CONCURRENCY });
  };

  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      const cached = initial.get(item.slug) || filmCacheGet(item.slug);
      if (cached?.metaComplete) {
        results[index] = cached;
        completed += 1;
        report();
        continue;
      }
      try {
        let film = await getTmdbFilm(item);
        if (!film) film = await getFilmDetails(item, {});
        results[index] = film;
      } catch {
        results[index] = basicFilmFromItem(item);
        failed += 1;
      }
      completed += 1;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(TMDB_CONCURRENCY, items.length) }, () => worker()));
  report(true);
  return results;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A source id is either a username ("justloay") or a list path
// ("justloay/list/road"). The id doubles as the cache key; list cache files
// replace "/" with "+" because "+" never appears in a valid username, so the
// two kinds can never collide in data/watchlists/.
const LIST_ID_RE = /^([a-z0-9_-]{1,30})\/list\/([a-z0-9-]{1,100})$/;

function parseSourceId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  if (!id) return null;
  const listMatch = LIST_ID_RE.exec(id);
  if (listMatch) {
    const [, owner, slug] = listMatch;
    if (!isValidUsername(owner) || !isValidListSlug(slug)) return null;
    return { kind: 'list', id, owner, slug, cacheFile: id.replace(/\//g, '+') };
  }
  if (id === 'demo') return { kind: 'demo', id, cacheFile: 'demo' };
  if (!isValidUsername(id)) return null;
  return { kind: 'user', id, username: id, cacheFile: id };
}

function sourceUrl(src) {
  return src.kind === 'list' ? `${BASE}/${src.owner}/list/${src.slug}/` : `${BASE}/${src.id}/watchlist/`;
}

function cacheFileFor(sourceId) {
  const src = parseSourceId(sourceId);
  return src ? src.cacheFile : null;
}

function cachePath(cacheFile) {
  return path.join(CACHE_DIR, `${cacheFile}.json`);
}

/* ── Persistent L2 cache (optional, Upstash Redis REST) ──────────
   The free Render disk is wiped on every deploy, so a list that took a
   minute to enrich goes cold again. A Redis layer survives deploys: once
   anyone has loaded a list, every later request — from this boot or a
   rebuilt one — reads back in ~100 ms. Enable by setting
   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash free tier
   is enough); without them the server behaves exactly as before. */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 30;
const redisKeyFor = (cacheFile) => `tonights-movie:cache:${cacheFile}`;
// Admin gate for ?refresh=1 (see handleWatchlistStream). Empty = disabled.
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.result === 'string' ? body.result : null;
  } catch {
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${REDIS_TTL_SECONDS}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      body: value,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // The cache is best-effort; a missed write only costs a future re-scrape.
  }
}

async function redisDel(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort, like every other Redis write here.
  }
}

async function readCached(sourceId) {
  const cacheFile = cacheFileFor(sourceId);
  if (!cacheFile) return null;
  const finish = (parsed) => {
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    const age = Date.now() - new Date(parsed.fetchedAt).getTime();
    return { payload: parsed, fresh: Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS };
  };
  try {
    const raw = await fsp.readFile(cachePath(cacheFile), 'utf8');
    return finish(JSON.parse(raw));
  } catch {
    // Disk miss (fresh deploy) — fall through to Redis.
  }
  const redisRaw = await redisGet(redisKeyFor(cacheFile));
  if (!redisRaw) return null;
  let parsed;
  try {
    parsed = JSON.parse(redisRaw);
  } catch {
    return null;
  }
  const result = finish(parsed);
  if (!result) return null;
  // Hydrate the local disk so later reads skip the network hop.
  fsp
    .mkdir(CACHE_DIR, { recursive: true })
    .then(() => fsp.writeFile(cachePath(cacheFile), redisRaw, 'utf8'))
    .catch(() => {});
  return result;
}

async function writeCache(payload) {
  const cacheFile = cacheFileFor(payload.username);
  if (!cacheFile) throw new Error(`Unsupported cache key: ${payload.username}`);
  const text = JSON.stringify(payload);
  // Durable tier first and independent of the disk: if the ephemeral
  // filesystem is ever full or read-only, Redis must not lose the snapshot
  // too (a failed disk write used to skip the Redis copy entirely).
  redisSet(redisKeyFor(cacheFile), text);
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const target = cachePath(cacheFile);
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, target);
  } catch (error) {
    console.warn(`[cache] disk write failed for ${cacheFile}:`, error.message);
  }
}

async function readDemo() {
  const raw = await fsp.readFile(DEMO_PATH, 'utf8');
  const payload = JSON.parse(raw);
  return { ...payload, version: CACHE_VERSION, username: 'demo', demo: true, detailsComplete: true };
}

// Visitors far from the origin (the Gulf routes at ~80 KB/s) feel every
// uncompressed byte, so large bodies travel gzip'd. Browsers and curl send
// Accept-Encoding: gzip by default; anything else gets plain JSON.
function acceptsGzip(req) {
  return String(req?.headers?.['accept-encoding'] || '').includes('gzip');
}

// decodeURIComponent throws URIError on malformed sequences such as %E0%A4%A.
// A broken URL is a client error (400), never a 500.
function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function sendJson(res, status, body, options = {}) {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': MIME['.json'],
    // Callers that serve immutable content (e.g. a translation of a fixed
    // text) pass their own policy; the browser then skips the round trip.
    'Cache-Control': options.cacheControl || 'no-store',
    Vary: 'Accept-Encoding',
    ...options.headers,
  };
  if (acceptsGzip(res.req) && text.length > 1024) {
    // Off the event loop: a 700 KB watchlist snapshot used to block every
    // other request for the whole gzip pass.
    zlib.gzip(text, (error, gz) => {
      if (error || res.writableEnded || res.destroyed) {
        // Fall through to the plain body; a failed compression must not
        // strand the response.
        if (!res.writableEnded && !res.destroyed && !res.headersSent) {
          res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
          res.end(text);
        }
        return;
      }
      res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    });
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// ── Per-IP rate limiting ─────────────────────────────────────────
// In-memory sliding-window counters per IP and endpoint family. Render's
// proxy sets x-forwarded-for; without it (local dev) the socket address is
// used. Buckets are pruned on touch and the map is hard-bounded, so a flood
// of unique spoofed IPs costs a counter reset, never memory.
const RATE_LIMITS = {
  stream: { limit: 15, windowMs: 60000 },
  film: { limit: 60, windowMs: 60000 },
  translate: { limit: 30, windowMs: 60000 },
};
const rateBuckets = new Map(); // ip -> Map(bucket -> timestamps[])

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function rateAllowed(req, bucket) {
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const ip = clientIp(req);
  const now = Date.now();
  let perIp = rateBuckets.get(ip);
  if (!perIp) {
    perIp = new Map();
    rateBuckets.set(ip, perIp);
  }
  const stamps = (perIp.get(bucket) || []).filter((t) => now - t < windowMs);
  if (stamps.length >= limit) {
    perIp.set(bucket, stamps);
    return false;
  }
  stamps.push(now);
  perIp.set(bucket, stamps);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return true;
}

function sendRateLimited(res, bucket) {
  console.log(`[ratelimit] ${bucket}: ${clientIp(res.req)} hit the cap`);
  sendJson(
    res,
    429,
    { error: 'Too many requests. Slow down.' },
    { headers: { 'Retry-After': String(Math.ceil(RATE_LIMITS[bucket].windowMs / 1000)) } }
  );
}

function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// SSE over gzip. Every frame must reach the browser the moment it is
// written, so each write sync-flushes a fresh gzip block (Z_SYNC_FLUSH) —
// the standard way to stream through gzip. A 772-film snapshot is ~700 KB
// raw and the long-haul routes crawl at ~80 KB/s; compressed it is ~6x
// smaller, so the cached path drops from ~9s to ~2s.
function sseTarget(req, res) {
  if (!acceptsGzip(req)) return res;
  const gz = zlib.createGzip({ level: 6, flush: zlib.constants.Z_SYNC_FLUSH });
  gz.pipe(res);
  gz.on('error', () => res.destroy());
  let ended = false;
  return {
    write: (chunk) => { if (!ended) gz.write(chunk); return true; },
    end: () => { if (!ended) { ended = true; gz.end(); } },
    get writableEnded() { return ended || res.writableEnded; },
    get destroyed() { return res.destroyed; },
  };
}

function startJob(sourceId, previous = null) {
  const src = parseSourceId(sourceId);
  const job = {
    username: sourceId,
    listeners: new Set(),
    progress: { phase: 'starting', message: 'Opening the projection booth…' },
    startedAt: Date.now(),
    status: 'running',
    basics: null,
    result: null,
    error: null,
  };
  jobs.set(sourceId, job);

  let lastDetailReport = 0;
  const emit = (event, data) => {
    for (const listener of job.listeners) listener(event, data);
  };
  const onProgress = (progress) => {
    job.progress = progress;
    if (progress.phase === 'details') {
      const now = Date.now();
      if (progress.completed !== progress.total && now - lastDetailReport < 500) return;
      lastDetailReport = now;
      // Heap trajectory per progress tick: a climbing line here means real
      // retention; a flat line under stalls means throttling (403/429s).
      const mem = process.memoryUsage();
      console.log(
        `[job] ${sourceId}: details ${progress.completed}/${progress.total} failed=${progress.failed} ` +
          `limit=${progress.limit ?? '?'} heap=${Math.round(mem.heapUsed / 1e6)}MB rss=${Math.round(mem.rss / 1e6)}MB`
      );
    }
    emit('progress', progress);
  };

  job.promise = (async () => {
    // Reuse every film detail we already read for this user (in-memory or in
    // the previous cache file). A refresh then only fetches new films instead
    // of re-reading hundreds of unchanged film pages.
    // filmCache entries are wrapped ({ film, fetchedAt }); the seed map holds
    // bare film objects, exactly what enrichFilms' `initial` expects.
    const seeded = new Map();
    for (const [slug, entry] of filmCache) seeded.set(slug, entry.film);
    const previousAge = Date.now() - new Date(previous?.fetchedAt || 0).getTime();
    const canSeed = Number.isFinite(previousAge) && previousAge >= 0 && previousAge < SEED_MAX_AGE_MS;
    if (canSeed) {
      for (const film of previous.films || []) {
        if (film?.slug && film.metaComplete && !seeded.has(film.slug)) seeded.set(film.slug, film);
      }
    }

    // Progressive cold load: the first card appears after page 1 alone, and
    // every later page streams its NEW films into the app the user is already
    // looking at. Deltas — never full re-sends — keep bandwidth linear, so a
    // 500-page list costs the same per film as a 10-page one; a timer
    // coalesces pages that land together into one frame.
    let pickItem = null;
    let pick = null;
    let pickPromise = null;
    let streamStarted = false;
    let flushTimer = null;
    const delivered = new Set();
    let deltaBuffer = [];

    const toFilm = (item) => seeded.get(item.slug) || basicFilmFromItem(item);

    // The headline pick: a TMDB film when the API is wired (instant, Arabic
    // synopsis included), otherwise a priority jump through the Letterboxd
    // gate. A TMDB match miss falls back to the Letterboxd page, so the pick
    // is always fully read either way.
    const fetchPickFilm = (item) =>
      (TMDB_KEY ? getTmdbFilm(item) : Promise.resolve(null)).then((film) =>
        film || getFilmDetails(item, { firstTimeoutMs: 5000, priority: true })
      );

    const flushDelta = () => {
      flushTimer = null;
      if (job.status !== 'running' || !deltaBuffer.length) return;
      const films = deltaBuffer.map(toFilm);
      deltaBuffer = [];
      emit('more', { films, total: delivered.size });
    };

    // Scrape done: the coalescer may still hold pages that landed inside its
    // 800ms window — flush them as one final delta. `delivered` marks films
    // as queued (not sent), so the buffer is the source of truth here; an
    // earlier version discarded it and relied on a full re-send, which the
    // delta streaming no longer performs.
    const flushRemaining = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!streamStarted || !deltaBuffer.length || job.status !== 'running') {
        deltaBuffer = [];
        return;
      }
      const films = deltaBuffer.map(toFilm);
      deltaBuffer = [];
      emit('more', { films, total: delivered.size });
    };

    const onPage = (items) => {
      if (!pickItem) {
        // Variety is the product: random among already-read films when seeds
        // make that free, else random from the page. The chosen film IS the
        // headline card now, so this single fetch is never wasted.
        const seededOnPage = items.filter((item) => seeded.has(item.slug));
        pickItem = seededOnPage.length
          ? seededOnPage[Math.floor(Math.random() * seededOnPage.length)]
          : items[Math.floor(Math.random() * items.length)];
        pick = seeded.get(pickItem.slug) || null;
        if (!pick) {
          // Priority jump through the shared gate: the pick waits for at most
          // one in-flight slot instead of the whole burst, and every other
          // reader of the same slug joins this one promise. Short first
          // attempt so a tarpitted read retries fast. Timed so regressions
          // show in the log directly.
          const pickStartedAt = Date.now();
          pickPromise = fetchPickFilm(pickItem)
            .then((film) => {
              if (film.metaComplete) {
                seeded.set(film.slug, film);
              }
              console.log(`[pick] ${film.slug}: ${Date.now() - pickStartedAt}ms`);
              return film;
            })
            .catch((error) => {
              console.log(`[pick] ${pickItem.slug}: failed in ${Date.now() - pickStartedAt}ms (${error?.status || error?.message})`);
              return basicFilmFromItem(pickItem);
            });
          pickPromise
            .then((film) => {
              pick = film;
              if (job.status === 'running') emit('pick', { pick: film });
            })
            .catch(() => {});
        }
      }

      const fresh = [];
      for (const item of items) {
        if (delivered.has(item.slug)) continue;
        delivered.add(item.slug);
        fresh.push(item);
      }
      if (!fresh.length) return;

      if (!streamStarted) {
        // First frame is a full snapshot: the card draws from it immediately.
        // The headline card is the pick — random even on a cold load. Its
        // details are the one fetch already in flight, so the client's
        // on-demand read joins the same promise and the card fills in place.
        streamStarted = true;
        const films = fresh.map(toFilm);
        emit('films', { films, total: films.length, pick: pick || toFilm(pickItem) });
        return;
      }

      deltaBuffer.push(...fresh);
      if (!flushTimer) flushTimer = setTimeout(flushDelta, 800);
    };

    const scrapePromise =
      src.kind === 'list'
        ? scrapeList(src.owner, src.slug, { pageConcurrency: PAGE_CONCURRENCY, onProgress, onPage })
        : scrapeWatchlist(src.username, { pageConcurrency: PAGE_CONCURRENCY, onProgress, onPage });
    const watchlist = await scrapePromise;

    // Scrape done: top up whatever the coalescer never flushed. A connection
    // that streamed deltas receives only the missing tail — re-sending the
    // whole list there would be exactly the quadratic cost the deltas avoid.
    flushRemaining();

    const basics = watchlist.items.map(basicFilmFromItem);
    if (!pickItem) {
      // Defensive: onPage fires for page 1 unconditionally, so this only runs
      // if a future refactor changes that contract. Same policy as onPage:
      // random among seeded films when free, else random — the pick headlines.
      const seededAny = watchlist.items.filter((item) => seeded.has(item.slug));
      pickItem = seededAny.length
        ? seededAny[Math.floor(Math.random() * seededAny.length)]
        : watchlist.items[Math.floor(Math.random() * watchlist.items.length)];
      pick = seeded.get(pickItem.slug) || null;
    }
    if (!pick) {
      const pickStartedAt = Date.now();
      pickPromise =
        pickPromise ||
        fetchPickFilm(pickItem)
          .then((film) => {
            if (film.metaComplete) {
              seeded.set(film.slug, film);
            }
            console.log(`[pick] ${film.slug}: ${Date.now() - pickStartedAt}ms`);
            return film;
          })
          .catch((error) => {
            console.log(`[pick] ${pickItem.slug}: failed in ${Date.now() - pickStartedAt}ms (${error?.status || error?.message})`);
            return basicFilmFromItem(pickItem);
          });
    }

    job.progress = { phase: 'details', completed: 0, total: basics.length, failed: 0 };

    // Read the rest of the details in the background for the filters. The
    // shared gate + dedupe read path means: one global limit across every
    // concurrent job, and each film cached the moment its read completes.
    const enrichedPromise = TMDB_KEY
      ? tmdbEnrich(basics, { onProgress, initial: seeded })
      : enrichFilms(watchlist.items, {
          concurrency: FILM_CONCURRENCY,
          gate: filmGate,
          fetchOne: cachedFilmDetails,
          initial: seeded,
          onProgress,
        });

    pick = pick || (await pickPromise);

    // Warm the Arabic synopsis the moment the pick is known: the client asks
    // for it as soon as the card renders, and a translation that started here
    // (in parallel with scraping) turns that request into a memory hit
    // instead of a provider round trip at the front of the serial queue.
    // TMDB synopses arrive already Arabic — nothing to warm.
    if (pick?.overview && pick.overviewLang !== 'ar') translate(pick.overview, 'ar').catch(() => {});

    // The first pick is fully read before the app appears, so the landing ->
    // result transition feels immediate. Every other film is enriched in the
    // background for filters.
    const basicsWithPick = watchlist.items.map((item) => (item.slug === pick.slug ? pick : toFilm(item)));
    const base = {
      version: CACHE_VERSION,
      username: sourceId,
      kind: src.kind === 'list' ? 'list' : 'watchlist',
      owner: src.kind === 'list' ? src.owner : undefined,
      slug: src.kind === 'list' ? src.slug : undefined,
      fetchedAt: new Date().toISOString(),
      source: sourceUrl(src),
      pagesFetched: watchlist.pagesFetched,
      pagesTotal: watchlist.pagesTotal,
      listStatus: watchlist.lastListStatus,
      failedPages: watchlist.failedPages,
      truncated: watchlist.truncated,
      total: basics.length,
      films: basicsWithPick,
      stats: computeStats(basicsWithPick),
      detailsComplete: false,
      pick,
    };

    job.basics = base;
    // Full snapshot only for connections that never entered delta streaming
    // (single-page lists get it as their one and only frame). Streamed loads
    // keep their deltas; the final 'more' above topped up the tail.
    if (job.status === 'running' && !streamStarted) emit('films', base);

    const enriched = await enrichedPromise;

    const enrichedPick = enriched.find((film) => film.slug === pick.slug);
    const payload = {
      ...base,
      fetchedAt: new Date().toISOString(),
      films: enriched,
      stats: computeStats(enriched),
      detailsComplete: true,
      // Prefer the fully read pick; the background pass may have raced it and
      // fallen back to a title-only entry.
      pick: enrichedPick?.metaComplete ? enrichedPick : pick,
    };

    job.status = 'done';
    job.result = payload;
    // A heavily throttled run (Letterboxd tarpitting the host IP) produces
    // mostly fallback films; caching that would serve a degraded list for the
    // whole TTL window. Keep this run's result for its connected clients, but
    // leave the durable cache to a healthier pass.
    const failedCount = enriched.reduce((n, film) => n + (film.metaComplete ? 0 : 1), 0);
    if (failedCount * 4 <= enriched.length) {
      await writeCache(payload).catch((error) => {
        console.warn(`[cache] could not write ${sourceId}:`, error.message);
      });
    } else {
      console.warn(`[cache] skipped ${sourceId}: ${failedCount}/${enriched.length} films failed`);
    }
    emit('done', { cached: false, ...payload });
    return payload;
  })()
    .catch((error) => {
      if (job.status === 'done') return null;
      job.status = 'error';
      job.error = {
        message: error.message || 'Could not load that list.',
        code: error.code || 'LOAD_FAILED',
      };
      emit('error', job.error);
      return null;
    })
    .finally(() => {
      setTimeout(() => {
        if (jobs.get(sourceId) === job) jobs.delete(sourceId);
      }, 30000).unref?.();
    });

  return job;
}

async function handleWatchlistStream(req, res, sourceIdRaw, url) {
  if (!rateAllowed(req, 'stream')) {
    sendRateLimited(res, 'stream');
    return;
  }
  const source = parseSourceId(decodePath(sourceIdRaw));
  if (!source) {
    sendJson(res, 400, {
      error: 'Enter a valid Letterboxd username (letters, numbers, dashes, underscores) or a list URL.',
    });
    return;
  }
  const sourceId = source.id;
  // Feeds prewarm (recently requested sources only) and cache eviction.
  noteAccess(sourceId);

  const openedAt = Date.now();
  const streamLog = (msg) => console.log(`[sse] ${sourceId}: ${msg} (+${Math.round((Date.now() - openedAt) / 1000)}s)`);
  res.on('close', () => streamLog(`closed (${res.writableEnded ? 'ended' : 'broken'})`));
  req.on('error', (err) => streamLog(`req error: ${err.message}`));
  res.on('error', (err) => streamLog(`res error: ${err.message}`));
  streamLog('connected');

  // Content-Encoding must ride inside writeHead: with explicit headers Node
  // commits them immediately, so a later setHeader throws HEADERS_SENT.
  const gzipped = acceptsGzip(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(gzipped ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
  });
  const out = sseTarget(req, res);
  out.write(': connected\n\n');

  if (sourceId === 'demo') {
    try {
      const demo = await readDemo();
      sseSend(out, 'done', { cached: false, ...demo });
    } catch {
      sseSend(out, 'error', { message: 'The demo dataset is missing. Run npm run build:demo.', code: 'DEMO_MISSING' });
    }
    out.end();
    return;
  }

  const refresh = url.searchParams.get('refresh') === '1';
  // Forcing a re-scrape is an admin action: unrestricted, anyone could bypass
  // the cache for every source and keep the server scraping Letterboxd around
  // the clock. Set REFRESH_TOKEN on the server to allow `?refresh=1&token=…`;
  // without it the parameter is always refused.
  if (refresh) {
    const token = String(url.searchParams.get('token') || '');
    if (!REFRESH_TOKEN || token !== REFRESH_TOKEN) {
      console.log(`[refresh] refused for ${sourceId} (no/invalid token)`);
      sseSend(out, 'error', {
        message: 'Refresh requires an admin token.',
        code: 'REFRESH_FORBIDDEN',
      });
      out.end();
      return;
    }
  }

  const cached = await readCached(sourceId);
  if (!refresh && cached?.fresh) {
    // Seed the film cache from the snapshot: every metaComplete film in it is
    // already fully read, so slug-based translation requests (and film API
    // repeats) resolve from memory instead of re-scraping Letterboxd.
    for (const film of cached.payload.films || []) {
      filmCacheSet(film.slug, film);
    }
    // The cached pick's Arabic may be cold after a deploy; warm it without
    // blocking the snapshot — the client's request joins it if still running.
    // TMDB synopses are already Arabic (overviewLang=ar), skip those.
    const pickPayload = cached.payload.pick;
    if (pickPayload?.overview && pickPayload.overviewLang !== 'ar') {
      translate(pickPayload.overview, 'ar').catch(() => {});
    }
    sseSend(out, 'done', { cached: true, ...cached.payload });
    out.end();
    return;
  }

  let job = jobs.get(sourceId);
  if (!job || (refresh && job.status !== 'running')) {
    job = startJob(sourceId, cached?.payload || null);
  }

  let heartbeat = null;
  let finished = false;
  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    job.listeners.delete(listener);
  };
  const listener = (event, data) => {
    if (event === 'error') streamLog(`sending error event: ${data?.message}`);
    sseSend(out, event, data);
    if (event === 'done' || event === 'error') {
      finished = true;
      cleanup();
      out.end();
    }
  };

  job.listeners.add(listener);
  heartbeat = setInterval(() => {
    if (!out.writableEnded) out.write(': ping\n\n');
  }, 15000);
  heartbeat.unref?.();

  req.on('close', cleanup);

  // A tab that joins mid-flight gets the basics immediately, then the same
  // aggregate progress and final payload as the first tab.
  if (job.status === 'done' && job.result) {
    listener('done', { cached: false, ...job.result });
    return;
  }
  if (job.status === 'error' && job.error) {
    listener('error', job.error);
    return;
  }
  if (job.basics) sseSend(out, 'films', job.basics);
  if (job.progress && !finished) sseSend(out, 'progress', job.progress);
}

async function handleWatchlist(req, res, sourceIdRaw) {
  if (!rateAllowed(req, 'stream')) {
    sendRateLimited(res, 'stream');
    return;
  }
  const source = parseSourceId(decodePath(sourceIdRaw));
  if (!source) {
    sendJson(res, 400, { error: 'Enter a valid Letterboxd username or list URL.' });
    return;
  }
  noteAccess(source.id);
  const sourceId = source.id;
  if (sourceId === 'demo') {
    try {
      sendJson(res, 200, await readDemo());
    } catch {
      sendJson(res, 500, { error: 'Demo dataset missing. Run npm run build:demo.' });
    }
    return;
  }
  const cached = await readCached(sourceId);
  if (!cached) {
    sendJson(res, 404, { error: 'Not cached yet. Use the streaming endpoint.', code: 'NOT_CACHED' });
    return;
  }
  sendJson(res, 200, { ...cached.payload, cached: true, stale: !cached.fresh });
}

async function handleFilm(req, res, slug) {
  if (!rateAllowed(req, 'film')) {
    sendRateLimited(res, 'film');
    return;
  }
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
    sendJson(res, 400, { error: 'Invalid film slug.' });
    return;
  }

  const cached = filmCacheGet(slug);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  const detailStartedAt = Date.now();
  try {
    const film = await getFilmDetails(
      {
        slug,
        link: `${BASE}/film/${slug}/`,
        fallbackTitle: slug.replace(/-/g, ' '),
        fallbackYear: null,
      },
      { firstTimeoutMs: 5000 }
    );
    console.log(`[film-api] ${slug}: ${Date.now() - detailStartedAt}ms`);
    sendJson(res, 200, film);
  } catch (error) {
    console.log(`[film-api] ${slug}: failed in ${Date.now() - detailStartedAt}ms (${error?.status || error?.message})`);
    if (error?.status === 404) {
      sendJson(res, 404, { error: 'Film not found.' });
    } else if (error?.status === 403 || error?.status === 429) {
      sendJson(res, 429, { error: 'Letterboxd is rate limiting requests. Try again shortly.' });
    } else {
      sendJson(res, 502, { error: 'Could not read that film page right now.' });
    }
  }
}

async function handleTranslate(req, res, url) {
  if (!rateAllowed(req, 'translate')) {
    sendRateLimited(res, 'translate');
    return;
  }
  const lang = String(url.searchParams.get('lang') || '').toLowerCase();
  const slug = String(url.searchParams.get('slug') || '').trim();

  if (lang !== 'ar') {
    sendJson(res, 400, { error: 'Unsupported language.' });
    return;
  }
  // Only film slugs are accepted — the server resolves the synopsis from its
  // own cache (or fetches that film page), so arbitrary client text never
  // reaches the translation provider. This endpoint can no longer be used as
  // an open relay to burn provider quota.
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
    sendJson(res, 400, { error: 'Missing or invalid film slug.' });
    return;
  }

  let overview = filmCacheGet(slug)?.overview;
  if (!overview) {
    const detailStartedAt = Date.now();
    try {
      const film = await getFilmDetails(
        {
          slug,
          link: `${BASE}/film/${slug}/`,
          fallbackTitle: slug.replace(/-/g, ' '),
          fallbackYear: null,
        },
        { firstTimeoutMs: 5000 }
      );
      overview = film.overview;
      // Logs on both the fetch and the join of an in-flight read; either way
      // this is one Letterboxd page for every requester of the slug.
      console.log(`[translate] ${slug}: overview ready in ${Date.now() - detailStartedAt}ms`);
    } catch (error) {
      console.log(`[translate] ${slug}: film fetch failed (${error?.status || error?.message})`);
      if (error?.status === 404) {
        sendJson(res, 404, { error: 'Film not found.' });
      } else if (error?.status === 403 || error?.status === 429) {
        sendJson(res, 429, { error: 'Letterboxd is rate limiting requests. Try again shortly.' });
      } else {
        sendJson(res, 502, { error: 'Could not read that film page right now.' });
      }
      return;
    }
  }
  if (!overview) {
    sendJson(res, 404, { error: 'No synopsis found for that film.' });
    return;
  }
  if (overview.length > 4000) {
    sendJson(res, 413, { error: 'Synopsis too long to translate.' });
    return;
  }

  const translated = await translate(overview, 'ar');
  if (!translated) {
    sendJson(res, 503, { error: 'Translation unavailable.' });
    return;
  }
  // The Arabic rendering of a fixed text never changes, so the browser may
  // keep it forever and skip future round trips for the same synopsis.
  sendJson(res, 200, { lang: 'ar', slug, text: translated }, { cacheControl: 'private, max-age=31536000, immutable' });
}

/* ── Poster proxy ────────────────────────────────────────────────
   The share-card canvas can only export pixels from same-origin images, and
   Letterboxd's image CDN (a.ltrbxd.com) sends no CORS headers. This route
   fetches a poster from that CDN and serves it from our own origin.
   It is deliberately narrow so it can never act as an open proxy:
   https only, *.ltrbxd.com only, no redirects, JPEG/PNG/WebP only, size
   capped. Posters are small, so a tiny in-memory LRU keeps repeat shares
   off the network without threatening the free-plan memory budget. */
const POSTER_HOST_RE = /^([a-z0-9-]+\.ltrbxd\.com|image\.tmdb\.org)$/;
const POSTER_TYPE_RE = /^image\/(jpeg|png|webp)$/;
const POSTER_MAX_BYTES = 3 * 1024 * 1024;
const POSTER_CACHE_MAX = 60;
const posterCache = new Map();

function posterTarget(raw) {
  if (!raw || raw.length > 600) return null;
  let target;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' || target.port || target.username || target.password) return null;
  if (!POSTER_HOST_RE.test(target.hostname)) return null;
  return target;
}

async function readCapped(response, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Poster too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handlePoster(req, res, url) {
  const target = posterTarget(url.searchParams.get('u'));
  if (!target) {
    sendJson(res, 400, { error: 'Invalid poster URL.' });
    return;
  }

  const key = target.href;
  let entry = posterCache.get(key);
  if (entry) {
    // Re-insert so the Map's insertion order doubles as LRU order.
    posterCache.delete(key);
    posterCache.set(key, entry);
  } else {
    try {
      const upstream = await fetch(key, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          Accept: 'image/jpeg,image/png,image/webp',
          'User-Agent': 'Mozilla/5.0 (compatible; TonightsMovie/1.0)',
        },
      });
      if (!upstream.ok) {
        sendJson(res, 502, { error: 'Poster unavailable.' });
        return;
      }
      const type = String(upstream.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!POSTER_TYPE_RE.test(type)) {
        sendJson(res, 502, { error: 'Unexpected poster type.' });
        return;
      }
      if (Number(upstream.headers.get('content-length')) > POSTER_MAX_BYTES) {
        sendJson(res, 413, { error: 'Poster too large.' });
        return;
      }
      entry = { type, body: await readCapped(upstream, POSTER_MAX_BYTES) };
      posterCache.set(key, entry);
      while (posterCache.size > POSTER_CACHE_MAX) posterCache.delete(posterCache.keys().next().value);
    } catch (error) {
      sendJson(res, error?.status === 413 ? 413 : 502, { error: 'Poster unavailable.' });
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': entry.body.length,
    // The URL carries Letterboxd's ?v= version, so a changed poster is a new key.
    'Cache-Control': 'public, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : entry.body);
}

// Whole-file gzip for text assets, memoized per file version. The page shell
// (~174 KB of JS/CSS/HTML) is a third of that compressed — and on slow
// long-haul routes every saved kilobyte is felt on first paint.
const GZIP_TYPES = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt', '.map']);
const gzipFileCache = new Map();

// Font binaries never change in practice (OFL files are stable), so they ship
// immutable. Text assets revalidate: a changed file costs one conditional
// request; an unchanged one costs a 304 with no body — which matters when the
// round trip alone is ~0.5s and app.js alone is ~24 KB compressed.
const IMMUTABLE_TYPES = new Set(['.woff2', '.woff', '.ttf', '.otf']);

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
}

// If-None-Match may list several validators with or without the weak marker
// and quotes; compare loosely on the core value.
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const core = etag.replace(/^W\//, '').replace(/"/g, '');
  return String(ifNoneMatch)
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//, '').replace(/"/g, '') === core);
}

async function sendStaticFile(req, res, filePath, stat, ext) {
  const etag = etagFor(stat);
  const cacheControl = IMMUTABLE_TYPES.has(ext)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
    res.end();
    return;
  }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
  };
  if (GZIP_TYPES.has(ext) && stat.size > 1024 && stat.size < 2 * 1024 * 1024 && acceptsGzip(req)) {
    const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
    let body = gzipFileCache.get(key);
    if (!body) {
      if (gzipFileCache.size > 64) gzipFileCache.clear();
      body = zlib.gzipSync(await fsp.readFile(filePath), { level: 6 });
      gzipFileCache.set(key, body);
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// Real storage self-test, run once per boot and memoized (the uptime pinger
// hits this route every few minutes — do not probe on every call). The disk
// probe writes and deletes a throwaway file; the Redis probe round-trips a
// tiny key. PONG alone cannot tell a working cache from one that silently
// fails its writes.
let storageProbePromise = null;
function storageProbe() {
  if (!storageProbePromise) {
    storageProbePromise = (async () => {
      let disk = 'ok';
      try {
        await fsp.mkdir(CACHE_DIR, { recursive: true });
        const probe = path.join(CACHE_DIR, '.probe');
        await fsp.writeFile(probe, String(Date.now()), 'utf8');
        await fsp.unlink(probe);
      } catch {
        disk = 'readonly';
      }
      let redis = 'off';
      if (REDIS_URL && REDIS_TOKEN) {
        try {
          const marker = `probe-${Date.now()}`;
          await redisSet('tonights-movie:health:probe', marker);
          redis = (await redisGet('tonights-movie:health:probe')) === marker ? 'roundtrip-ok' : 'broken';
        } catch {
          redis = 'error';
        }
      }
      return [disk, redis];
    })().catch(() => ['error', 'error']);
  }
  return storageProbePromise;
}

async function serveStatic(req, res, pathname) {
  let relative = decodePath(pathname);
  if (relative === null) {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }
  if (relative === '/') relative = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(relative).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    await sendStaticFile(req, res, filePath, stat, path.extname(filePath).toLowerCase());
  } catch {
    if (!path.extname(pathname)) {
      // Single-page fallback for pretty URLs.
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      const stat = await fsp.stat(indexPath);
      await sendStaticFile(req, res, indexPath, stat, '.html');
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}

// Popular official lists get warmed proactively, so the searches people make
// most often are already hot the first time anyone asks. Slugs verified live;
// override with POPULAR_LISTS="owner/list/slug,owner/list/slug".
const POPULAR_LISTS = (
  process.env.POPULAR_LISTS ||
  'official/list/letterboxds-top-500-films,official/list/official-top-100-narrative-feature-films'
)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ── Source access tracking ──────────────────────────────────────
// Prewarm and eviction need "when was this source last requested". Kept in
// memory, flushed periodically to data/access.json plus a Redis copy, so the
// record survives Render's ephemeral disk across deploys.
const ACCESS_FILE = path.join(ROOT, 'data', 'access.json');
const ACCESS_FLUSH_MS = 60000;
const PREWARM_RECENT_MS = Number(process.env.PREWARM_RECENT_DAYS || 3) * 24 * 60 * 60 * 1000;
const CACHE_EVICT_MS = Number(process.env.CACHE_EVICT_DAYS || 30) * 24 * 60 * 60 * 1000;
const accessTimes = new Map(); // sourceId -> last-request timestamp
let accessDirty = false;

function noteAccess(sourceId) {
  if (!sourceId || sourceId === 'demo') return;
  accessTimes.set(sourceId, Date.now());
  accessDirty = true;
}

async function loadAccessTimes() {
  const merge = (json) => {
    try {
      const data = JSON.parse(json);
      for (const [id, ts] of Object.entries(data)) {
        if (Number.isFinite(ts) && ts > (accessTimes.get(id) || 0)) accessTimes.set(id, ts);
      }
    } catch {
      // Missing or corrupt access data just means "unknown" for those sources.
    }
  };
  try {
    merge(await fsp.readFile(ACCESS_FILE, 'utf8'));
  } catch {}
  // The Redis copy outlives the ephemeral disk.
  merge(await redisGet('tonights-movie:access'));
}

async function flushAccessTimes() {
  if (!accessDirty) return;
  accessDirty = false;
  const text = JSON.stringify(Object.fromEntries(accessTimes));
  try {
    await fsp.mkdir(path.dirname(ACCESS_FILE), { recursive: true });
    await fsp.writeFile(ACCESS_FILE, text, 'utf8');
  } catch {}
  redisSet('tonights-movie:access', text);
}

async function prewarmStaleCaches() {
  if (!PREWARM || prewarming) return;
  prewarming = true;
  try {
    let names = [];
    try {
      names = await fsp.readdir(CACHE_DIR);
    } catch {
      names = [];
    }
    // Seeds: popular lists with no cache file yet (first boot or a wiped disk).
    // With Redis enabled, a Redis-only copy still counts as present — the disk
    // hydrates from it instead of re-scraping Letterboxd.
    const seedIds = [];
    for (const id of POPULAR_LISTS) {
      const file = cacheFileFor(id);
      if (file && !names.includes(`${file}.json`)) {
        const cached = await readCached(id);
        if (!cached) seedIds.push(id);
      }
    }
    const fileIds = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const cacheFile = name.slice(0, -'.json'.length);
        // "+" in a cache file can only come from a list id ("/" is not a legal
        // filename character), so the mapping back is unambiguous.
        return cacheFile.includes('+') ? cacheFile.replace(/\+/g, '/') : cacheFile;
      });
    // Sources never seen by this tracking get a baseline of "now": they earn a
    // full recent-window before becoming eviction candidates, rather than
    // being judged by a timestamp that does not exist.
    for (const id of fileIds) {
      if (!accessTimes.has(id)) {
        accessTimes.set(id, Date.now());
        accessDirty = true;
      }
    }

    // Eviction: caches nobody has requested for CACHE_EVICT_MS are deleted
    // from disk and Redis, so server load no longer grows with every user
    // ever searched. Popular lists are never evicted.
    for (const sourceId of fileIds) {
      if (POPULAR_LISTS.includes(sourceId)) continue;
      const last = accessTimes.get(sourceId) || 0;
      if (Date.now() - last < CACHE_EVICT_MS) continue;
      console.log(`[prewarm] evicting cache for ${sourceId} (no requests in ${Math.round(CACHE_EVICT_MS / 86400000)} days)`);
      await fsp.unlink(cachePath(cacheFileFor(sourceId))).catch((error) => {
        console.warn(`[prewarm] evict disk ${sourceId}: ${error.message}`);
      });
      await redisDel(redisKeyFor(cacheFileFor(sourceId)));
      accessTimes.delete(sourceId);
      accessDirty = true;
    }

    // Only popular lists plus sources requested recently get refreshed, so the
    // sweep stays proportional to actual traffic instead of growing forever.
    const recentIds = fileIds.filter((sourceId) => {
      const last = accessTimes.get(sourceId) || 0;
      return Date.now() - last < PREWARM_RECENT_MS;
    });
    for (const sourceId of [...seedIds, ...recentIds]) {
      const src = parseSourceId(sourceId);
      if (!src || src.kind === 'demo' || jobs.has(sourceId)) continue;
      const cached = await readCached(sourceId);
      if (!cached) {
        if (seedIds.includes(sourceId)) {
          console.log(`[prewarm] seeding popular list ${sourceId}`);
          await startJob(sourceId).promise.catch(() => {});
          await sleep(1500);
        }
        continue;
      }
      // Fresh caches already answer immediately; only stale ones need the
      // network, and doing it now means the next visitor never sees a wait.
      if (cached.fresh) continue;
      console.log(`[prewarm] refreshing stale cache for ${sourceId}`);
      await startJob(sourceId, cached.payload).promise;
      await sleep(1500);
    }
  } finally {
    prewarming = false;
  }
}

// ── Security headers ─────────────────────────────────────────────
// Applied to every response from the router below. The CSP allows only
// same-origin resources: posters load through /api/poster, fonts are
// self-hosted, and the inline <script> blocks (theme/language bootstrap,
// JSON-LD) are pinned by hash so no unsafe-inline is needed. Hashes are
// recomputed when index.html changes (mtime-checked like the gzip cache),
// so editing the page never silently breaks itself.
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;

const cspCache = { mtimeMs: 0, policy: '' };

async function contentSecurityPolicy() {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let stat;
  try {
    stat = await fsp.stat(indexPath);
  } catch {
    return ''; // No policy rather than a policy that bricks the page.
  }
  if (cspCache.mtimeMs !== stat.mtimeMs) {
    const html = await fsp.readFile(indexPath, 'utf8');
    const hashes = [];
    for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
      // Hash the exact text between the tags — that is what the browser
      // hashes. JSON-LD is inert data, but hashing it too is harmless and
      // keeps the policy correct if its type ever changes.
      const hash = crypto.createHash('sha256').update(match[2]).digest('base64');
      hashes.push(`'sha256-${hash}'`);
    }
    cspCache.mtimeMs = stat.mtimeMs;
    cspCache.policy = [
      "default-src 'self'",
      hashes.length ? `script-src 'self' ${hashes.join(' ')}` : "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return cspCache.policy;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) console.log(`[req] ${req.method} ${url.pathname}${url.search}`);

  try {
    // Framing, sniffing and referrer policy apply to every response; the CSP
    // is skipped only if index.html could not be read.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const csp = await contentSecurityPolicy();
    if (csp) res.setHeader('Content-Security-Policy', csp);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url.pathname === '/api/health') {
      // Report real storage health: disk writability and an actual Redis
      // round trip, probed once per boot.
      const [disk, redis] = await storageProbe();
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), jobs: jobs.size, disk, redis });
      return;
    }

    if (url.pathname === '/api/demo') {
      sendJson(res, 200, await readDemo());
      return;
    }

    const streamMatch = /^\/api\/watchlist\/([^/]+)\/stream\/?$/.exec(url.pathname);
    if (streamMatch) {
      await handleWatchlistStream(req, res, streamMatch[1], url);
      return;
    }

    const listMatch = /^\/api\/watchlist\/([^/]+)\/?$/.exec(url.pathname);
    if (listMatch) {
      await handleWatchlist(req, res, listMatch[1]);
      return;
    }

    const filmMatch = /^\/api\/film\/([^/]+)\/?$/.exec(url.pathname);
    if (filmMatch) {
      await handleFilm(req, res, filmMatch[1]);
      return;
    }

    if (url.pathname === '/api/translate') {
      await handleTranslate(req, res, url);
      return;
    }

    if (url.pathname === '/api/poster') {
      await handlePoster(req, res, url);
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    } else {
      res.end();
    }
  }
});

// Diagnostics: surface process-level failures instead of dying silently.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

server.listen(PORT, HOST, () => {
  console.log(`\n  Tonight's Movie running at http://${HOST}:${PORT}\n`);
  console.log('  Demo dataset: (click "Try the demo" or load username "demo")');
  console.log('  Live mode reads every page of a watchlist or any public list, then enriches film details in the background.');
  console.log('  The first result appears as soon as the watchlist list is ready; filters unlock when details finish.');
  console.log(
    REDIS_URL && REDIS_TOKEN
      ? '  Persistent Redis cache: enabled (caches survive deploys).'
      : '  Persistent Redis cache: off (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable).'
  );
  if (PREWARM) {
    console.log('  Stale caches refresh in the background (PREWARM=0 disables this).\n');
    loadAccessTimes().catch(() => {});
    setTimeout(prewarmStaleCaches, 5000).unref?.();
    setInterval(prewarmStaleCaches, PREWARM_INTERVAL_MS).unref?.();
  } else {
    console.log('  Background prewarm disabled (PREWARM=0).\n');
    // Access tracking still runs: eviction decisions must be recorded even
    // while the refresh sweep is off.
    loadAccessTimes().catch(() => {});
  }
  setInterval(flushAccessTimes, ACCESS_FLUSH_MS).unref?.();
});
