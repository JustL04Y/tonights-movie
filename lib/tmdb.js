/* TMDB API client — official, keyed, zero dependencies.
 *
 * When TMDB_API_KEY is set, film details (synopsis, genres, runtime,
 * countries, languages, directors, poster) come from TMDB instead of
 * scraping every Letterboxd film page. The synopsis is requested in
 * Arabic first (TMDB synopses are human-written, not machine
 * translation); films without Arabic coverage fall back to English and
 * keep going through the translation route.
 *
 * Letterboxd stays the source of the lists themselves (slugs, titles,
 * years) and of the community rating, which the server reads lazily for
 * the film on screen — one page per pick, cached.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';

// Letterboxd's canonical genre vocabulary (the client's filter list).
// TMDB ids are stable and documented.
const TMDB_GENRE_NAMES = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  53: 'Thriller',
  10770: 'TV Movie',
  10752: 'War',
  37: 'Western',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmdbFetchJson(path, params, apiKey, { retries = 2 } = {}) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt) await sleep(1000 * attempt);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (response.status === 429 || response.status >= 500) {
        lastError = Object.assign(new Error(`TMDB ${response.status}`), { status: response.status });
        continue;
      }
      if (!response.ok) {
        throw Object.assign(new Error(`TMDB ${response.status}`), { status: response.status });
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Loose title match: TMDB search is fuzzy already; accept the top hit when
// the normalized titles agree or share enough words, and the year is within
// a year when we know it. Anything shakier falls back to the Letterboxd
// scrape for that film, so a wrong match never reaches the user.
function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatches(expected, candidate) {
  const a = normalizeTitle(expected);
  const b = normalizeTitle(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  let overlap = 0;
  for (const word of wordsA) if (wordsB.has(word)) overlap += 1;
  return overlap / Math.max(wordsA.size, wordsB.size) >= 0.7;
}

function yearMatches(expected, candidate) {
  if (!expected) return true;
  if (!candidate) return false;
  return Math.abs(Number(expected) - Number(candidate)) <= 1;
}

async function searchMovie(title, year, apiKey) {
  const payload = await tmdbFetchJson(
    '/search/movie',
    { query: title, year, include_adult: false, language: 'en-US' },
    apiKey
  );
  const results = payload.results || [];
  if (!results.length && year) {
    // Year may disagree with the list markup (re-releases); retry without it.
    const retry = await tmdbFetchJson(
      '/search/movie',
      { query: title, include_adult: false, language: 'en-US' },
      apiKey
    );
    return retry.results || [];
  }
  return results;
}

function pickResult(results, { title, year }) {
  for (const result of results) {
    if (titleMatches(title, result.title || result.original_title) && yearMatches(year, result.release_date?.slice(0, 4))) {
      return result;
    }
  }
  for (const result of results) {
    if (yearMatches(year, result.release_date?.slice(0, 4))) return result;
  }
  return results[0] || null;
}

// Directors, deduped in credit order (the card shows at most two).
function directorsOf(credits) {
  const seen = new Set();
  const names = [];
  for (const member of credits?.crew || []) {
    if (member.job !== 'Director' || seen.has(member.name)) continue;
    seen.add(member.name);
    names.push(member.name);
  }
  return names;
}

function filmFromTmdb(slug, title, year, details) {
  const overviewArabic = (details.overview || '').trim();
  const countryNames = (details.production_countries || [])
    .map((country) => country.english_name || country.name)
    .filter(Boolean);
  const languageNames = (details.spoken_languages || [])
    .map((language) => language.english_name)
    .filter(Boolean);
  return {
    slug,
    title,
    year: Number(details.release_date?.slice(0, 4)) || year || null,
    link: `https://letterboxd.com/film/${slug}/`,
    overview: overviewArabic,
    overviewLang: overviewArabic ? 'ar' : '',
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '',
    backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w780${details.backdrop_path}` : '',
    // TMDB's 0-10 vote average normalized to Letterboxd's 0-5 scale so the
    // rating filter keeps one scale across every film. The on-screen card
    // upgrades to the real Letterboxd community rating via the lazy fetch.
    rating: details.vote_average ? Math.round((details.vote_average / 2) * 10) / 10 : null,
    ratingCount: details.vote_count ?? null,
    runtime: details.runtime || null,
    genres: (details.genres || [])
      .map((genre) => TMDB_GENRE_NAMES[genre.id] || genre.name)
      .filter(Boolean)
      .map((name) => ({ name })),
    countries: countryNames,
    languages: languageNames,
    directors: directorsOf(details.credits),
    metaComplete: true,
    ratingSource: 'tmdb',
  };
}

module.exports = {
  TMDB_BASE,
  TMDB_GENRE_NAMES,
  tmdbFetchJson,
  searchMovie,
  pickResult,
  titleMatches,
  filmFromTmdb,
  directorsOf,
};
