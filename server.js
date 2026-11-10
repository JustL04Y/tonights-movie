'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
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
const MEM_DEFAULTS = IS_RENDER ? { page: 4, film: 8 } : { page: 12, film: 32 };
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.PAGE_CONCURRENCY || MEM_DEFAULTS.page));
const FILM_CONCURRENCY = Math.max(1, Number(process.env.FILM_CONCURRENCY || MEM_DEFAULTS.film));
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

async function readCached(sourceId) {
  const cacheFile = cacheFileFor(sourceId);
  if (!cacheFile) return null;
  try {
    const raw = await fsp.readFile(cachePath(cacheFile), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CACHE_VERSION) return null;
    const age = Date.now() - new Date(parsed.fetchedAt).getTime();
    return { payload: parsed, fresh: Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  const cacheFile = cacheFileFor(payload.username);
  if (!cacheFile) throw new Error(`Unsupported cache key: ${payload.username}`);
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const target = cachePath(cacheFile);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fsp.rename(tmp, target);
}

async function readDemo() {
  const raw = await fsp.readFile(DEMO_PATH, 'utf8');
  const payload = JSON.parse(raw);
  return { ...payload, version: CACHE_VERSION, username: 'demo', demo: true, detailsComplete: true };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

    const scrapePromise =
      src.kind === 'list'
        ? scrapeList(src.owner, src.slug, { pageConcurrency: PAGE_CONCURRENCY, onProgress })
        : scrapeWatchlist(src.username, { pageConcurrency: PAGE_CONCURRENCY, onProgress });
    const watchlist = await scrapePromise;

    const basics = watchlist.items.map(basicFilmFromItem);
    const pickItem = watchlist.items[Math.floor(Math.random() * watchlist.items.length)];

    job.progress = { phase: 'details', completed: 0, total: basics.length, failed: 0 };

    // Read the first pick and enrich the rest at the same time. The pick still
    // arrives before the app appears, but the details pass no longer waits for
    // that one page to finish, which saves a full round trip on a cold load.
    let pick = seeded.get(pickItem.slug);
    const pickPromise = pick
      ? Promise.resolve(pick)
      : fetchFilmDetails(pickItem)
          .then((film) => {
            if (film.metaComplete) {
              seeded.set(film.slug, film);
              filmCache.set(film.slug, film);
            }
            return film;
          })
          .catch(() => basicFilmFromItem(pickItem));

    const enrichedPromise = enrichFilms(watchlist.items, {
      concurrency: FILM_CONCURRENCY,
      initial: seeded,
      onProgress,
    });

    pick = await pickPromise;

    // The first pick is fully read before the app appears, so the landing ->
    // result transition feels immediate. Every other film is enriched in the
    // background for filters.
    const basicsWithPick = basics.map((film) => (film.slug === pick.slug ? pick : film));
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
    if (job.status === 'running') emit('films', base);

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
    await writeCache(payload).catch((error) => {
      console.warn(`[cache] could not write ${sourceId}:`, error.message);
    });
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');

  if (sourceId === 'demo') {
    try {
      const demo = await readDemo();
      sseSend(res, 'done', { cached: false, ...demo });
    } catch {
      sseSend(res, 'error', { message: 'The demo dataset is missing. Run npm run build:demo.', code: 'DEMO_MISSING' });
    }
    res.end();
    return;
  }

  const refresh = url.searchParams.get('refresh') === '1';

  const cached = await readCached(sourceId);
  if (!refresh && cached?.fresh) {
    sseSend(res, 'done', { cached: true, ...cached.payload });
    res.end();
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
    sseSend(res, event, data);
    if (event === 'done' || event === 'error') {
      finished = true;
      cleanup();
      if (!res.writableEnded) res.end();
    }
  };

  job.listeners.add(listener);
  heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
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
  if (job.basics) sseSend(res, 'films', job.basics);
  if (job.progress && !finished) sseSend(res, 'progress', job.progress);
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

  try {
    const film = await fetchFilmDetails({
      slug,
      link: `${BASE}/film/${slug}/`,
      fallbackTitle: slug.replace(/-/g, ' '),
      fallbackYear: null,
    });
    if (film.metaComplete) filmCache.set(slug, film);
    sendJson(res, 200, film);
  } catch (error) {
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
  sendJson(res, 200, { lang: 'ar', text: translated });
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
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // Assets are not content-hashed, so revalidate them on every load.
      'Cache-Control': 'no-cache',
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch {
    if (!path.extname(pathname)) {
      // Single-page fallback for pretty URLs.
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      const stat = await fsp.stat(indexPath);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function prewarmStaleCaches() {
  if (!PREWARM || prewarming) return;
  prewarming = true;
  try {
    let names = [];
    try {
      names = await fsp.readdir(CACHE_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const cacheFile = name.slice(0, -'.json'.length);
      // "+" in a cache file can only come from a list id ("/" is not a legal
      // filename character), so the mapping back is unambiguous.
      const sourceId = cacheFile.includes('+') ? cacheFile.replace(/\+/g, '/') : cacheFile;
      const src = parseSourceId(sourceId);
      if (!src || src.kind === 'demo' || jobs.has(sourceId)) continue;
      const cached = await readCached(sourceId);
      // Fresh caches already answer immediately; only stale ones need the
      // network, and doing it now means the next visitor never sees a wait.
      if (!cached || cached.fresh) continue;
      console.log(`[prewarm] refreshing stale cache for ${sourceId}`);
      await startJob(sourceId, cached.payload).promise;
      await sleep(1500);
    }
  } finally {
    prewarming = false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) console.log(`[req] ${req.method} ${url.pathname}${url.search}`);

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), jobs: jobs.size });
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
  if (PREWARM) {
    console.log('  Stale caches refresh in the background (PREWARM=0 disables this).\n');
    setTimeout(prewarmStaleCaches, 5000).unref?.();
    setInterval(prewarmStaleCaches, PREWARM_INTERVAL_MS).unref?.();
  } else {
    console.log('  Background prewarm disabled (PREWARM=0).\n');
  }
});
