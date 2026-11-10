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

async function fetchText(url, { timeoutMs = 20000, retries = 2, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  return items;
}

function parseLastPage(html) {
  const block = /<div class="paginate-pages">([\s\S]*?)<\/div>/.exec(html)?.[1] || html;
  const pages = [...block.matchAll(/\/watchlist\/page\/(\d+)\//g)].map((match) => Number(match[1]));
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

  return {
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
  };
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

async function scrapeWatchlist(
  username,
  { onProgress, maxPages = 200, signal, pageDelayMs = 100, pageConcurrency = 5 } = {}
) {
  let first;
  try {
    first = await fetchWatchlistPage(username, 1, { signal });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw Object.assign(new Error("Couldn't find that Letterboxd user."), { code: 'USER_NOT_FOUND' });
    }
    if (error instanceof HttpError && (error.status === 403 || error.status === 429)) {
      throw Object.assign(
        new Error('Letterboxd is rate limiting watchlist requests right now. Try again in a minute.'),
        { code: 'RATE_LIMITED' }
      );
    }
    throw error;
  }

  if (!first.items.length) {
    if (first.notFound) {
      throw Object.assign(new Error("Couldn't find that Letterboxd user. Check the username and try again."), {
        code: 'USER_NOT_FOUND',
      });
    }
    // Either an empty watchlist or a private one. Letterboxd renders an empty grid for both.
    const html = first.html || '';
    if (/This member.s watchlist is private|is private/i.test(html)) {
      throw Object.assign(
        new Error('That watchlist is private. Make it public on Letterboxd first.'),
        { code: 'PRIVATE_WATCHLIST' }
      );
    }
    throw Object.assign(
      new Error('That watchlist is empty (or not visible). Add a film or make the list public.'),
      { code: 'EMPTY_WATCHLIST' }
    );
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

  report();

  if (pagesTotal > 1) {
    const pageNumbers = Array.from({ length: pagesTotal - 1 }, (_, index) => index + 2);
    await mapWithConcurrency(
      pageNumbers,
      Math.min(Math.max(1, pageConcurrency), pageNumbers.length),
      async (page) => {
        try {
          const result = await fetchWatchlistPage(username, page, { signal });
          if (!result.items.length) throw new Error(`Empty watchlist page ${page}`);
          pages.set(page, result.items);
          filmsFound += result.items.length;
        } catch (error) {
          if (signal?.aborted) throw error;
          failedPages.push({ page, message: error.message || 'Page failed' });
        }
        completedPages += 1;
        report();
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
        const result = await fetchWatchlistPage(username, entry.page, { signal });
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
  }

  const items = [];
  const seen = new Set();
  for (let page = 1; page <= pagesTotal; page += 1) {
    for (const item of pages.get(page) || []) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      items.push(item);
    }
  }

  return {
    items,
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

async function fetchFilmDetails(item, { signal, retries = 2 } = {}) {
  const link = item.link || `${BASE}/film/${item.slug}/`;
  const html = await fetchText(link, { signal, retries });
  return parseFilmPage(html, { ...item, link });
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
    onProgress({ phase: 'details', completed, total: items.length, failed });
  };

  const films = await mapWithConcurrency(
    items,
    Math.max(1, concurrency),
    async (item) => {
      const cached = initial.get(item.slug);
      if (cached) {
        completed += 1;
        report();
        return cached;
      }

      let film;
      try {
        film = await fetchFilmDetails(item, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        film = fallbackFilm(item);
        failed += 1;
      }

      completed += 1;
      report();
      if (requestDelayMs) await sleep(requestDelayMs + Math.floor(Math.random() * 90));
      return film;
    },
    { signal }
  );

  report(true);
  return films;
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

module.exports = {
  BASE,
  HttpError,
  normalizeUsername,
  isValidUsername,
  scrapeWatchlist,
  scrapeFilm: async (slug) => {
    const item = { slug, link: `${BASE}/film/${slug}/`, fallbackTitle: slug, fallbackYear: null };
    return parseFilmPage(await fetchText(item.link), item);
  },
  fetchFilmDetails,
  enrichFilms,
  loadWatchlist,
  computeStats,
  basicFilmFromItem,
  fallbackFilm,
  parseFilmPage,
  parseWatchlistPage,
  parseLastPage,
  decodeEntities,
  slugify,
};
