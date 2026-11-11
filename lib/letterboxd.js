'use strict';

const BASE = 'https://letterboxd.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HttpError extends Error {
  constructor(status, url) {
    super(`Request failed with ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function decodeEntities(value) {
  if (value == null) return '';
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
    eacute: 'é',
    egrave: 'è',
    agrave: 'à',
    uuml: 'ü',
    ouml: 'ö',
    auml: 'ä',
    ccedil: 'ç',
    ntilde: 'ñ',
    oslash: 'ø',
    aring: 'å',
    aelig: 'æ',
  };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function isValidUsername(username) {
  // Letterboxd allows underscores anywhere (e.g. "_515_"), so the client and
  // the server must agree on the same rule. A name that doesn't exist on
  // Letterboxd surfaces as a scrape error, not as a validation failure.
  return /^[a-z0-9_-]{1,30}$/.test(username);
}

async function fetchText(url, { timeoutMs = 20000, retries = 2, signal, firstTimeoutMs } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    // Optional short leash for the first attempt: user-facing reads (the pick,
    // /api/film) should abort a tarpitted request and retry instead of hanging
    // the full 20s while a visitor stares at the loading note.
    const timer = setTimeout(
      () => controller.abort(),
      attempt === 0 && firstTimeoutMs ? firstTimeoutMs : timeoutMs
    );
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (response.status === 404) {
        throw new HttpError(404, url);
      }
      if (!response.ok) {
        throw new HttpError(response.status, url);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError') {
        lastError = new HttpError(0, url);
        lastError.message = `Request timed out for ${url}`;
      }
      const retryable =
        !(error instanceof HttpError) ||
        error.status === 0 ||
        error.status === 403 ||
        error.status === 429 ||
        error.status >= 500;
      if (!retryable || attempt === retries) break;
      await sleep(700 * (attempt + 1) + Math.floor(Math.random() * 250));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

// V8 sliced/cons strings extracted with regex keep their whole parent page
// alive: a regex-captured title or overview inside a film object pinned a
// ~500 KB film page in memory for as long as that film was cached, so a
// 771-film enrichment OOM'd Render's free container at ~565 films. Cloning
// the plain data through JSON breaks every reference chain. Measured with
// capture/memtest.js: ~631 KB retained per film before, single KBs after.
const cloneFlat = (value) => JSON.parse(JSON.stringify(value));

function parseWatchlistPage(html) {
  const items = [];
  const seen = new Set();
  const blockRe = /<div class="react-component"[^>]*data-component-class="LazyPoster"[\s\S]*?>/gi;
  let match;
  while ((match = blockRe.exec(html))) {
    const block = match[0];
    const slug = /data-item-slug="([^"]*)"/.exec(block)?.[1];
    if (!slug || seen.has(slug)) continue;
    const link = /data-item-link="([^"]*)"/.exec(block)?.[1];
    const displayName = decodeEntities(
      /data-item-full-display-name="([^"]*)"/.exec(block)?.[1] ||
        /data-item-name="([^"]*)"/.exec(block)?.[1] ||
        ''
    );
    const yearMatch = /\((\d{4})\)\s*$/.exec(displayName);
    seen.add(slug);
    items.push({
      slug,
      link: link ? new URL(link, BASE).toString() : `${BASE}/film/${slug}/`,
      displayName,
      fallbackTitle: displayName.replace(/\s*\(\d{4}\)\s*$/, ''),
      fallbackYear: yearMatch ? Number(yearMatch[1]) : null,
    });
  }
  return cloneFlat(items);
}

function parseLastPage(html) {
  const block = /<div class="paginate-pages">([\s\S]*?)<\/div>/.exec(html)?.[1] || html;
  // Watchlist pages link /user/watchlist/page/N/ and list pages link
  // /owner/list/slug/page/N/ — both end in /page/N/, so one pattern covers them.
  const pages = [...block.matchAll(/\/page\/(\d+)\//g)].map((match) => Number(match[1]));
  return pages.length ? Math.max(...pages) : 1;
}

function basicFilmFromItem(item) {
  return {
    slug: item.slug,
    title: item.fallbackTitle || item.slug,
    year: item.fallbackYear || null,
    link: item.link,
    overview: '',
    poster: '',
    backdrop: '',
    rating: null,
    ratingCount: null,
    runtime: null,
    genres: [],
    countries: [],
    languages: [],
    directors: [],
    metaComplete: false,
  };
}

function fallbackFilm(item) {
  return basicFilmFromItem(item);
}

function extractJsonLdMovie(html) {
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    let body = match[1]
      .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '')
      .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '')
      .trim();
    try {
      const parsed = JSON.parse(body);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        if (node['@type'] === 'Movie' || (Array.isArray(node['@type']) && node['@type'].includes('Movie'))) {
          return node;
        }
        if (Array.isArray(node['@graph'])) {
          const movie = node['@graph'].find(
            (entry) => entry && (entry['@type'] === 'Movie' || entry['@type'] === 'Film')
          );
          if (movie) return movie;
        }
      }
    } catch {
      // Ignore invalid JSON-LD blocks and keep scanning.
    }
  }
  return null;
}

function parseIsoDuration(value) {
  if (!value || typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(value);
  if (!m) return null;
  const minutes = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return minutes > 0 ? minutes : null;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function namesFrom(value) {
  return toArray(value)
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter(Boolean)
    .map((entry) => stripTags(entry));
}

const LANGUAGE_ALIASES = {
  cn: 'zh', // Letterboxd occasionally emits the country code for Chinese.
  in: 'id',
  iw: 'he',
  ji: 'yi',
  xx: null, // Placeholder for an unknown language.
};

const languageNames = (() => {
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'language' });
    return (code) => {
      try {
        return display.of(code) || code;
      } catch {
        return code;
      }
    };
  } catch {
    return (code) => code;
  }
})();

function parseFilmPage(html, item) {
  const ld = extractJsonLdMovie(html) || {};
  const meta = (property) => {
    const re = new RegExp(
      `<meta[^>]*(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`,
      'i'
    );
    const alt = new RegExp(
      `<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
      'i'
    );
    return decodeEntities(re.exec(html)?.[1] ?? alt.exec(html)?.[1] ?? '');
  };

  const ogTitle = meta('og:title');
  const title = stripTags(ld.name || ogTitle.replace(/\s*\(\d{4}\)\s*$/, '') || item.fallbackTitle);
  const yearFromTitle = /\((\d{4})\)\s*$/.exec(ogTitle)?.[1];
  const year = Number(ld.dateCreated?.slice(0, 4)) || Number(yearFromTitle) || item.fallbackYear || null;

  const genres = [...new Set(namesFrom(ld.genre))].map((name) => ({
    name,
    slug: slugify(name),
  }));

  const countries = [...new Set(namesFrom(ld.countryOfOrigin))];

  const languageCodes = toArray(ld.inLanguage)
    .map((entry) => (typeof entry === 'string' ? entry : entry?.alternateName || entry?.name))
    .filter(Boolean);
  const languages = [
    ...new Set(
      languageCodes
        .map((code) => {
          const key = String(code).toLowerCase();
          if (Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, key)) return LANGUAGE_ALIASES[key];
          return code;
        })
        .filter(Boolean)
        .map((code) => languageNames(code))
    ),
  ].filter((name) => name && name !== 'Unknown language');

  const directors = [...new Set(namesFrom(ld.director))];

  const ratingValue = Number(ld.aggregateRating?.ratingValue);
  const ratingCount = Number(ld.aggregateRating?.ratingCount);

  const poster =
    (typeof ld.image === 'string' ? ld.image : ld.image?.url) ||
    meta('og:image') ||
    '';
  const backdrop = meta('og:image') || poster;

  const runtime = parseIsoDuration(ld.duration);

  return cloneFlat({
    slug: item.slug,
    title,
    year: Number.isFinite(year) ? year : null,
    link: ld.url || item.link,
    overview: stripTags(ld.description || meta('og:description')),
    poster,
    backdrop,
    rating: Number.isFinite(ratingValue) && ratingValue > 0 ? Math.round(ratingValue * 100) / 100 : null,
    ratingCount: Number.isFinite(ratingCount) ? ratingCount : null,
    runtime,
    genres,
    countries,
    languages,
    directors,
    metaComplete: true,
  });
}

function isValidListSlug(slug) {
  return /^[a-z0-9-]{1,100}$/.test(slug);
}

async function fetchWatchlistPage(username, page, options) {
  const url = `${BASE}/${username}/watchlist/page/${page}/`;
  try {
    const html = await fetchText(url, options);
    return { items: parseWatchlistPage(html), html };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return { items: [], html: null, notFound: true };
    throw error;
  }
}

async function fetchListPage(owner, slug, page, options) {
  // Page one is the canonical list URL; later pages append /page/N/.
  const url = page === 1 ? `${BASE}/${owner}/list/${slug}/` : `${BASE}/${owner}/list/${slug}/page/${page}/`;
  try {
    const html = await fetchText(url, options);
    return { items: parseWatchlistPage(html), html };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return { items: [], html: null, notFound: true };
    throw error;
  }
}

// Shared pagination engine for watchlists and lists. `fetchPage(page, options)`
// returns { items, html, notFound? }; `notFound` and `onEmpty` carry the
// source-specific error mapping (a missing user vs a missing list).
async function scrapePaginated(
  fetchPage,
  { onProgress, onPage, maxPages = 200, signal, pageDelayMs = 100, pageConcurrency = 5, notFound, onEmpty } = {}
) {
  let first;
  try {
    first = await fetchPage(1, { signal });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw Object.assign(new Error(notFound.message), { code: notFound.code });
    }
    if (error instanceof HttpError && (error.status === 403 || error.status === 429)) {
      throw Object.assign(
        new Error('Letterboxd is rate limiting requests right now. Try again in a minute.'),
        { code: 'RATE_LIMITED' }
      );
    }
    throw error;
  }

  if (!first.items.length) {
    if (first.notFound) {
      throw Object.assign(new Error(notFound.retryMessage || notFound.message), { code: notFound.code });
    }
    if (onEmpty) onEmpty(first.html || '');
    // Either an empty source or a private one that renders an empty grid.
    throw Object.assign(new Error('That list is empty (or not visible).'), { code: 'EMPTY_LIST' });
  }

  const lastPage = parseLastPage(first.html || '');
  const pagesTotal = Math.min(maxPages, Math.max(1, lastPage));
  const truncated = lastPage > pagesTotal;
  const pages = new Map([[1, first.items]]);
  const failedPages = [];
  let completedPages = 1;
  let filmsFound = first.items.length;

  const report = () => {
    if (!onProgress) return;
    onProgress({
      phase: 'watchlist',
      page: completedPages,
      pagesTotal,
      filmsFound,
      failed: failedPages.length,
    });
  };

  // Everything collected so far, deduped in page order. Lets callers stream
  // a usable film pool while later pages are still in flight.
  const collect = () => {
    const items = [];
    const seen = new Set();
    for (let page = 1; page <= pagesTotal; page += 1) {
      for (const item of pages.get(page) || []) {
        if (seen.has(item.slug)) continue;
        seen.add(item.slug);
        items.push(item);
      }
    }
    return items;
  };
  const reportPage = () => {
    if (!onPage) return;
    onPage(collect());
  };

  report();
  reportPage();

  if (pagesTotal > 1) {
    const pageNumbers = Array.from({ length: pagesTotal - 1 }, (_, index) => index + 2);
    await mapWithConcurrency(
      pageNumbers,
      Math.min(Math.max(1, pageConcurrency), pageNumbers.length),
      async (page) => {
        try {
          const result = await fetchPage(page, { signal });
          if (!result.items.length) throw new Error(`Empty page ${page}`);
          pages.set(page, result.items);
          filmsFound += result.items.length;
        } catch (error) {
          if (signal?.aborted) throw error;
          failedPages.push({ page, message: error.message || 'Page failed' });
        }
        completedPages += 1;
        report();
        reportPage();
        if (pageDelayMs) await sleep(pageDelayMs + Math.floor(Math.random() * 120));
      },
      { signal }
    );
  }

  // One quiet sequential retry for pages that failed while the pool was busy.
  if (failedPages.length) {
    const retry = failedPages.splice(0);
    for (const entry of retry) {
      await sleep(500);
      try {
        const result = await fetchPage(entry.page, { signal });
        if (result.items.length) {
          pages.set(entry.page, result.items);
          filmsFound += result.items.length;
        } else {
          failedPages.push(entry);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failedPages.push(entry);
      }
    }
    report();
    reportPage();
  }

  return {
    items: collect(),
    pagesFetched: pagesTotal - failedPages.length,
    pagesTotal,
    lastListStatus: failedPages.length ? 'partial' : 'ok',
    failedPages,
    truncated,
  };
}

async function mapWithConcurrency(entries, concurrency, worker, { signal } = {}) {
  let nextIndex = 0;
  const results = new Array(entries.length);
  const workers = new Array(Math.min(concurrency, entries.length)).fill(null).map(async () => {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      results[index] = await worker(entries[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scrapeWatchlist(username, options = {}) {
  const { onProgress, onPage, maxPages, signal, pageDelayMs, pageConcurrency } = options;
  return scrapePaginated((page, opts) => fetchWatchlistPage(username, page, opts), {
    onProgress,
    onPage,
    maxPages,
    signal,
    pageDelayMs,
    pageConcurrency,
    notFound: {
      code: 'USER_NOT_FOUND',
      message: "Couldn't find that Letterboxd user.",
      retryMessage: "Couldn't find that Letterboxd user. Check the username and try again.",
    },
    onEmpty: (html) => {
      // Either an empty watchlist or a private one; Letterboxd renders an
      // empty grid for both.
      if (/This member.s watchlist is private|is private/i.test(html)) {
        throw Object.assign(new Error('That watchlist is private. Make it public on Letterboxd first.'), {
          code: 'PRIVATE_WATCHLIST',
        });
      }
      throw Object.assign(
        new Error('That watchlist is empty (or not visible). Add a film or make the list public.'),
        { code: 'EMPTY_WATCHLIST' }
      );
    },
  });
}

async function scrapeList(owner, slug, options = {}) {
  const { onProgress, onPage, maxPages, signal, pageDelayMs, pageConcurrency } = options;
  return scrapePaginated((page, opts) => fetchListPage(owner, slug, page, opts), {
    onProgress,
    onPage,
    maxPages,
    signal,
    pageDelayMs,
    pageConcurrency,
    notFound: {
      code: 'LIST_NOT_FOUND',
      message: "Couldn't find that Letterboxd list. Check the link and try again.",
    },
    onEmpty: () => {
      throw Object.assign(new Error('That list is empty (or not visible).'), { code: 'EMPTY_LIST' });
    },
  });
}

async function fetchFilmDetails(item, { signal, retries = 2, firstTimeoutMs } = {}) {
  const link = item.link || `${BASE}/film/${item.slug}/`;
  const html = await fetchText(link, { signal, retries, firstTimeoutMs });
  return parseFilmPage(html, { ...item, link });
}

/* Adaptive concurrency gate (additive increase, multiplicative decrease).
   Letterboxd tolerates high parallelism until it suddenly does not; the
   honest way to run close to that line without provoking 403/429 storms is
   to ramp upward slowly and halve instantly on the first throttle signal.
   The heap side is safe since cloneFlat: in-flight buffers are ~1-2 MB each. */
function createThrottleGate({ start, max, min = 4, cooldownMs = 1500 }) {
  let limit = Math.max(1, Math.min(start, max));
  let active = 0;
  let cleanStreak = 0;
  let cooldownUntil = 0;
  const waiters = [];

  const wake = () => {
    while (active < limit && waiters.length) {
      active += 1;
      waiters.shift()();
    }
  };

  return {
    async acquire() {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      active = Math.max(0, active - 1);
      wake();
    },
    get limit() {
      return limit;
    },
    success() {
      cleanStreak += 1;
      if (cleanStreak >= 10 && limit < max) {
        cleanStreak = 0;
        limit += 1;
        wake();
      }
    },
    throttle() {
      cleanStreak = 0;
      limit = Math.max(min, Math.floor(limit / 2));
      cooldownUntil = Date.now() + cooldownMs;
      wake();
    },
  };
}

async function enrichFilms(
  items,
  { onProgress, concurrency = 16, signal, requestDelayMs = 0, initial = new Map() } = {}
) {
  let completed = 0;
  let failed = 0;
  let lastReportAt = 0;

  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReportAt < 350) return;
    lastReportAt = now;
    onProgress({ phase: 'details', completed, total: items.length, failed, limit: gate.limit });
  };

  // Start at the configured concurrency and let the gate probe up to twice
  // that (never beyond 48) as long as Letterboxd stays friendly.
  const max = Math.max(concurrency, Math.min(concurrency * 2, 48));
  const gate = createThrottleGate({ start: concurrency, max });

  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];

      // Already enriched (seeding or an on-demand pick) — no server hit, so
      // it neither consumes a slot nor feeds the ramp.
      const cached = initial.get(item.slug);
      if (cached) {
        results[index] = cached;
        completed += 1;
        report();
        continue;
      }

      await gate.acquire();
      try {
        let film;
        try {
          film = await fetchFilmDetails(item, { signal });
          gate.success();
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error?.status === 403 || error?.status === 429) gate.throttle();
          film = fallbackFilm(item);
          failed += 1;
        }
        completed += 1;
        report();
        if (requestDelayMs) await sleep(requestDelayMs + Math.floor(Math.random() * 90));
        results[index] = film;
      } finally {
        gate.release();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => worker()));
  report(true);
  return results;
}

function computeStats(films) {
  const genres = new Map();
  const countries = new Map();
  const decades = new Map();
  const languages = new Map();
  let ratingSum = 0;
  let ratingCount = 0;
  let runtimeSum = 0;
  let runtimeCount = 0;

  for (const film of films) {
    for (const genre of film.genres) genres.set(genre.name, (genres.get(genre.name) || 0) + 1);
    for (const country of film.countries) countries.set(country, (countries.get(country) || 0) + 1);
    for (const language of film.languages) languages.set(language, (languages.get(language) || 0) + 1);
    if (film.year) {
      const decade = Math.floor(film.year / 10) * 10;
      decades.set(decade, (decades.get(decade) || 0) + 1);
    }
    if (typeof film.rating === 'number') {
      ratingSum += film.rating;
      ratingCount += 1;
    }
    if (film.runtime) {
      runtimeSum += film.runtime;
      runtimeCount += 1;
    }
  }

  const sorted = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    total: films.length,
    withMetadata: films.filter((film) => film.metaComplete).length,
    rated: ratingCount,
    averageRating: ratingCount ? Math.round((ratingSum / ratingCount) * 100) / 100 : null,
    averageRuntime: runtimeCount ? Math.round(runtimeSum / runtimeCount) : null,
    totalRuntime: runtimeCount ? Math.round(runtimeSum / 60) : null,
    genres: sorted(genres),
    countries: sorted(countries),
    languages: sorted(languages),
    decades: [...decades.entries()]
      .map(([decade, count]) => ({ decade, count }))
      .sort((a, b) => a.decade - b.decade),
  };
}

async function loadWatchlist(usernameRaw, options = {}) {
  const username = normalizeUsername(usernameRaw);
  if (!username) {
    throw Object.assign(new Error('Enter a Letterboxd username.'), { code: 'INVALID_USERNAME' });
  }
  if (!isValidUsername(username)) {
    throw Object.assign(new Error('That username has characters Letterboxd usernames do not use.'), {
      code: 'INVALID_USERNAME',
    });
  }

  const watchlist = await scrapeWatchlist(username, options);
  const films = await enrichFilms(watchlist.items, options);
  return {
    version: 2,
    username,
    fetchedAt: new Date().toISOString(),
    source: `${BASE}/${username}/watchlist/`,
    pagesFetched: watchlist.pagesFetched,
    pagesTotal: watchlist.pagesTotal,
    listStatus: watchlist.lastListStatus,
    failedPages: watchlist.failedPages,
    truncated: watchlist.truncated,
    films,
    stats: computeStats(films),
    detailsComplete: true,
  };
}

async function loadList(owner, slug, options = {}) {
  if (!isValidUsername(owner)) {
    throw Object.assign(new Error('That list owner has an unexpected name.'), { code: 'INVALID_USERNAME' });
  }
  if (!isValidListSlug(slug)) {
    throw Object.assign(new Error('That list link has an unexpected slug.'), { code: 'INVALID_LIST' });
  }

  const list = await scrapeList(owner, slug, options);
  const films = await enrichFilms(list.items, options);
  return {
    version: 2,
    username: `${owner}/list/${slug}`,
    kind: 'list',
    owner,
    slug,
    fetchedAt: new Date().toISOString(),
    source: `${BASE}/${owner}/list/${slug}/`,
    pagesFetched: list.pagesFetched,
    pagesTotal: list.pagesTotal,
    listStatus: list.lastListStatus,
    failedPages: list.failedPages,
    truncated: list.truncated,
    films,
    stats: computeStats(films),
    detailsComplete: true,
  };
}

module.exports = {
  BASE,
  HttpError,
  normalizeUsername,
  isValidUsername,
  isValidListSlug,
  scrapeWatchlist,
  scrapeList,
  fetchListPage,
  scrapeFilm: async (slug) => {
    const item = { slug, link: `${BASE}/film/${slug}/`, fallbackTitle: slug, fallbackYear: null };
    return parseFilmPage(await fetchText(item.link), item);
  },
  fetchFilmDetails,
  enrichFilms,
  loadWatchlist,
  loadList,
  computeStats,
  basicFilmFromItem,
  fallbackFilm,
  parseFilmPage,
  parseWatchlistPage,
  parseLastPage,
  decodeEntities,
  slugify,
};
