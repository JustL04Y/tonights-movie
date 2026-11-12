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
  computeStats,
  basicFilmFromItem,
  isValidUsername,
  isValidListSlug,
} = require('./lib/letterboxd');
const { translate } = require('./lib/translate');

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
const CACHE_VERSION = 2;
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
const filmCache = new Map();
let prewarming = false;

// De-duplicates concurrent reads of the same film page: the pick fetch and a
// client /api/film request for the slug on screen share one promise instead of
// doubling the hit on Letterboxd.
const detailInFlight = new Map();
function queueFilmDetails(item, options = {}) {
  const existing = detailInFlight.get(item.slug);
  if (existing) return existing;
  const promise = fetchFilmDetails(item, options).finally(() => {
    detailInFlight.delete(item.slug);
  });
  detailInFlight.set(item.slug, promise);
  return promise;
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

function sendJson(res, status, body, options = {}) {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': MIME['.json'],
    // Callers that serve immutable content (e.g. a translation of a fixed
    // text) pass their own policy; the browser then skips the round trip.
    'Cache-Control': options.cacheControl || 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (acceptsGzip(res.req) && text.length > 1024) {
    const gz = zlib.gzipSync(text);
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.end(gz);
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
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
    const seeded = new Map(filmCache);
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
          // Gate-free single fetch so the pick never queues behind the
          // enrichment burst; short first attempt so a tarpitted read retries
          // fast. Timed so regressions show in the log directly.
          const pickStartedAt = Date.now();
          pickPromise = queueFilmDetails(pickItem, { firstTimeoutMs: 5000 })
            .then((film) => {
              if (film.metaComplete) {
                seeded.set(film.slug, film);
                filmCache.set(film.slug, film);
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
        queueFilmDetails(pickItem, { firstTimeoutMs: 5000 })
          .then((film) => {
            if (film.metaComplete) {
              seeded.set(film.slug, film);
              filmCache.set(film.slug, film);
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

    // Read the rest of the details in the background for the filters.
    const enrichedPromise = enrichFilms(watchlist.items, {
      concurrency: FILM_CONCURRENCY,
      initial: seeded,
      onProgress,
    });

    pick = pick || (await pickPromise);

    // Warm the Arabic synopsis the moment the pick is known: the client asks
    // for it as soon as the card renders, and a translation that started here
    // (in parallel with scraping) turns that request into a memory hit
    // instead of a provider round trip at the front of the serial queue.
    if (pick?.overview) translate(pick.overview, 'ar').catch(() => {});

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

    for (const film of enriched) {
      if (film.metaComplete) filmCache.set(film.slug, film);
    }

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
  const source = parseSourceId(decodeURIComponent(sourceIdRaw));
  if (!source) {
    sendJson(res, 400, {
      error: 'Enter a valid Letterboxd username (letters, numbers, dashes, underscores) or a list URL.',
    });
    return;
  }
  const sourceId = source.id;

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

  const cached = await readCached(sourceId);
  if (!refresh && cached?.fresh) {
    // The cached pick's Arabic may be cold after a deploy; warm it without
    // blocking the snapshot — the client's request joins it if still running.
    if (cached.payload.pick?.overview) translate(cached.payload.pick.overview, 'ar').catch(() => {});
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
  const source = parseSourceId(decodeURIComponent(sourceIdRaw));
  if (!source) {
    sendJson(res, 400, { error: 'Enter a valid Letterboxd username or list URL.' });
    return;
  }
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
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
    sendJson(res, 400, { error: 'Invalid film slug.' });
    return;
  }

  const cached = filmCache.get(slug);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  const detailStartedAt = Date.now();
  try {
    const film = await queueFilmDetails(
      {
        slug,
        link: `${BASE}/film/${slug}/`,
        fallbackTitle: slug.replace(/-/g, ' '),
        fallbackYear: null,
      },
      { firstTimeoutMs: 5000 }
    );
    if (film.metaComplete) filmCache.set(slug, film);
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
  const lang = String(url.searchParams.get('lang') || '').toLowerCase();
  const text = String(url.searchParams.get('q') || '').trim();

  if (lang !== 'ar') {
    sendJson(res, 400, { error: 'Unsupported language.' });
    return;
  }
  if (!text) {
    sendJson(res, 400, { error: 'Missing text.' });
    return;
  }
  if (text.length > 4000) {
    sendJson(res, 413, { error: 'Text too long.' });
    return;
  }

  const translated = await translate(text, 'ar');
  if (!translated) {
    sendJson(res, 503, { error: 'Translation unavailable.' });
    return;
  }
  // The Arabic rendering of a fixed text never changes, so the browser may
  // keep it forever and skip future round trips for the same synopsis.
  sendJson(res, 200, { lang: 'ar', text: translated }, { cacheControl: 'private, max-age=31536000, immutable' });
}

/* ── Poster proxy ────────────────────────────────────────────────
   The share-card canvas can only export pixels from same-origin images, and
   Letterboxd's image CDN (a.ltrbxd.com) sends no CORS headers. This route
   fetches a poster from that CDN and serves it from our own origin.
   It is deliberately narrow so it can never act as an open proxy:
   https only, *.ltrbxd.com only, no redirects, JPEG/PNG/WebP only, size
   capped. Posters are small, so a tiny in-memory LRU keeps repeat shares
   off the network without threatening the free-plan memory budget. */
const POSTER_HOST_RE = /^[a-z0-9-]+\.ltrbxd\.com$/;
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
  let relative = decodeURIComponent(pathname);
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
    for (const sourceId of [...seedIds, ...fileIds]) {
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
    setTimeout(prewarmStaleCaches, 5000).unref?.();
    setInterval(prewarmStaleCaches, PREWARM_INTERVAL_MS).unref?.();
  } else {
    console.log('  Background prewarm disabled (PREWARM=0).\n');
  }
});
