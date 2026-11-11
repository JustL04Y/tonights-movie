'use strict';

/* ─────────────────────────────────────────────────────────────
   Tonight's Movie — simplified client
   One card, one filter panel, no dashboard.
   ───────────────────────────────────────────────────────────── */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const { t, genre: tGenre, country: tCountry } = window.I18N;

const els = {
  backdrop: $('#backdrop'),
  landing: $('#landingView'),
  loading: $('#loadingView'),
  app: $('#appView'),
  loadForm: $('#loadForm'),
  username: $('#usernameInput'),
  userSuggestions: $('#userSuggestions'),
  loadError: $('#loadError'),
  demoBtn: $('#demoBtn'),
  cancelLoad: $('#cancelLoad'),
  loadingTitle: $('#loadingTitle'),
  loadingSub: $('#loadingSub'),
  progressFill: $('#progressFill'),
  progressCount: $('#progressCount'),
  userChip: $('#userChip'),
  brandLink: $('#brandLink'),
  themeToggle: $('#themeToggle'),
  langToggle: $('#langToggle'),
  shortcutsToggle: $('#shortcutsToggle'),
  shortcutsDialog: $('#shortcutsDialog'),
  shortcutsClose: $('#shortcutsClose'),
  themeColor: $('#themeColor'),
  usernameOut: $('#usernameOut'),
  kickerPrefix: $('#kickerPrefix'),
  kickerSuffix: $('#kickerSuffix'),
  matchCount: $('#matchCount'),
  poolLabel: $('#poolLabel'),
  activeChips: $('#activeChips'),
  detailsStrip: $('#detailsStrip'),
  detailsText: $('#detailsText'),
  detailsFill: $('#detailsFill'),
  filterPanel: $('#filterPanel'),
  filterPanelState: $('#filterPanelState'),
  filterLoading: $('#filterLoading'),
  filterBody: $('#filterBody'),
  filterUnavailable: $('#filterUnavailable'),
  genreChips: $('#genreChips'),
  genreSummary: $('#genreSummary'),
  ratingSummary: $('#ratingSummary'),
  ratingRange: $('#ratingRange'),
  ratingOutput: $('#ratingOutput'),
  runtimeRange: $('#runtimeRange'),
  runtimeOutput: $('#runtimeOutput'),
  runtimeSummary: $('#runtimeSummary'),
  runtimeSlider: $('#runtimeSlider'),
  runtimeEmpty: $('#runtimeEmpty'),
  runtimeScaleMax: $('#runtimeScaleMax'),
  decadeChips: $('#decadeChips'),
  decadeSummary: $('#decadeSummary'),
  countryChips: $('#countryChips'),
  countrySummary: $('#countrySummary'),
  clearFilters: $('#clearFilters'),
  spotlight: $('#spotlight'),
  pickBar: $('#pickBar'),
  pickBtn: $('#pickBtn'),
  pickNote: $('#pickNote'),
  emptyState: $('#emptyState'),
  emptyReset: $('#emptyReset'),
  toast: $('#toast'),
  srStatus: $('#srStatus'),
};

const RATING_MAX = 5;
// Runtime limit slider: the first stop (just under an hour) means "any", so one
// hour is the lowest real limit you can choose. The upper bound is derived from
// the list itself (rounded, capped) so short watchlists still get a useful track.
const RUNTIME_SLIDER_MIN = 55;
const RUNTIME_SLIDER_MAX = 300;
const RUNTIME_STEP = 5;
const USER_HISTORY_KEY = 'tonights-movie:user-history';
const USER_HISTORY_LIMIT = 8;
const THEME_KEY = 'tonights-movie:theme';
// How long a failed synopsis translation waits before it may be retried.
// Backs off so a transient provider outage heals itself while the film stays
// on screen, instead of leaving the English synopsis up until the next pick.
const TRANSLATION_RETRY_STEPS = [5000, 15000, 45000, 120000];
const TRANSLATION_TIMEOUT_MS = 25000;

const state = {
  view: 'landing',
  username: '',
  films: [],
  filmBySlug: new Map(),
  total: 0,
  detailsComplete: false,
  rejoins: 0,
  keepaliveTimer: null,
  details: { completed: 0, total: 0, failed: 0 },
  facets: { genres: [], countries: [], decades: [], runtimeMax: 0, withMetadata: 0 },
  filters: defaultFilters(),
  pool: [],
  deck: [],
  current: null,
  picks: 0,
  source: null,
  pendingSlugs: new Set(),
  networkTimer: null,
  toastTimer: null,
  // Landing prefetch (see schedulePrefetch below): a cache-only snapshot of
  // the last-used source, consumed if the user searches that source again.
  prefetched: null,
  prefetchTimer: null,
  prefetchController: null,
  progress: null,
  errorKey: '',
  translations: new Map(),
  translationPending: new Set(),
  translationRetryAt: new Map(),
  translationTimers: new Map(),
  translationAttempts: new Map(),
};

/* ── Helpers ─────────────────────────────────────────────── */

function defaultFilters() {
  return {
    genres: new Set(),
    genreMode: 'any',
    rating: 0,
    runtime: 0,
    decades: new Set(),
    countries: new Set(),
  };
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    // Ignore malformed URLs.
  }
  return '';
}

function formatRuntime(minutes) {
  if (!minutes || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return t('runtime.minutes', { minutes: mins });
  if (!mins) return t('runtime.hours', { hours });
  return t('runtime.hoursMinutes', { hours, minutes: mins });
}

const compactNumber = (() => {
  try {
    const format = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
    return (value) => format.format(value);
  } catch {
    return (value) => String(value);
  }
})();

function normalizeInput(value) {
  let input = String(value || '').trim();
  if (!input) return '';
  // A pasted watchlist URL reduces to the username.
  const fromWatchlistUrl = /letterboxd\.com\/([^/?#]+)\/watchlist/i.exec(input);
  if (fromWatchlistUrl) input = fromWatchlistUrl[1];
  else {
    // A pasted list URL reduces to an "owner/list/slug" source id.
    const fromListUrl = /letterboxd\.com\/([^/?#]+)\/list\/([^/?#]+)/i.exec(input);
    if (fromListUrl) input = `${fromListUrl[1]}/list/${fromListUrl[2]}`;
  }
  return input.replace(/^@+/, '').toLowerCase();
}

function isValidUsername(username) {
  return /^[a-z0-9_-]{1,30}$/.test(username);
}

// A list source id looks like "owner/list/slug" (as extracted from a pasted
// list URL, or the bare path typed on its own).
function isValidListId(id) {
  return /^([a-z0-9_-]{1,30})\/list\/([a-z0-9-]{1,100})$/.test(id);
}

function isValidSource(id) {
  return isValidUsername(id) || isValidListId(id);
}

function parseSourceId(id) {
  const listMatch = /^([a-z0-9_-]{1,30})\/list\/([a-z0-9-]{1,100})$/.exec(id || '');
  if (listMatch) return { kind: 'list', owner: listMatch[1], slug: listMatch[2] };
  return { kind: 'user', username: id || '' };
}

// Ratings inside Letterboxd are decimal averages, so the slider keeps one
// decimal (3.7 rather than snapping to a half star).
function clampRating(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(RATING_MAX, Math.round(numeric * 10) / 10);
}

function clampDecade(value) {
  const year = Number(value);
  if (!Number.isFinite(year) || !year) return 0;
  const start = Math.floor(year / 10) * 10;
  return start >= 1870 && start <= 2090 ? start : 0;
}

// Runtime is stored in minutes; 0 means "no limit". The first thumb position
// (just under an hour) is the "any" stop, so anything at or below it clears the
// filter, one hour is the lowest real limit, and the rest snap to 5 minutes.
function clampRuntime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const stepped = Math.round(numeric / RUNTIME_STEP) * RUNTIME_STEP;
  if (stepped <= RUNTIME_SLIDER_MIN) return 0;
  return Math.min(RUNTIME_SLIDER_MAX, stepped);
}

function announce(message) {
  if (!els.srStatus) return;
  els.srStatus.textContent = '';
  setTimeout(() => {
    els.srStatus.textContent = message;
  }, 40);
}

function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add('is-on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 3200);
}

function showLoadError(message, key = '') {
  if (!els.loadError) return;
  state.errorKey = message ? key : '';
  els.loadError.textContent = message;
  els.loadError.hidden = !message;
}

/* Server errors arrive with a stable code (USER_NOT_FOUND, PRIVATE_WATCHLIST,
   …) plus an English message. Localize by code; fall back to the server's
   message for codes the dictionary does not know. */
const SERVER_ERROR_KEYS = {
  USER_NOT_FOUND: 'error.userNotFound',
  LIST_NOT_FOUND: 'error.listNotFound',
  PRIVATE_WATCHLIST: 'error.privateWatchlist',
  EMPTY_WATCHLIST: 'error.emptyWatchlist',
  EMPTY_LIST: 'error.emptyList',
  RATE_LIMITED: 'error.rateLimited',
  LOAD_FAILED: 'error.loadFailed',
  CANCELLED: 'error.loadFailed',
  DEMO_MISSING: 'error.demoMissing',
};

function serverErrorKey(parsed) {
  return (parsed?.code && SERVER_ERROR_KEYS[parsed.code]) || null;
}

/* ── Theme and language ──────────────────────────────────── */

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, { persist = true } = {}) {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');

  if (els.themeColor) {
    els.themeColor.setAttribute('content', theme === 'light' ? '#f5f3ef' : '#0c1014');
  }
  if (els.themeToggle) {
    const label = t(theme === 'light' ? 'theme.toDark' : 'theme.toLight');
    els.themeToggle.setAttribute('aria-label', label);
    els.themeToggle.setAttribute('title', label);
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be unavailable; the theme still applies for this visit.
    }
  }
}

function syncLanguageToggle() {
  if (!els.langToggle) return;
  const arabic = I18N.isArabic();
  els.langToggle.textContent = arabic ? 'EN' : 'ع';
  els.langToggle.setAttribute('lang', arabic ? 'en' : 'ar');
  els.langToggle.setAttribute('aria-label', t('lang.switch'));
  els.langToggle.setAttribute('title', t('lang.switch'));
}

/* ── Views ───────────────────────────────────────────────── */

function setView(view) {
  state.view = view;
  els.landing.classList.toggle('hidden', view !== 'landing');
  els.loading.classList.toggle('hidden', view !== 'loading');
  els.app.classList.toggle('hidden', view !== 'app');
}

function showLanding() {
  stopSource();
  state.username = '';
  state.films = [];
  state.filmBySlug = new Map();
  state.total = 0;
  state.detailsComplete = false;
  state.facets = { genres: [], countries: [], decades: [], runtimeMax: 0, withMetadata: 0 };
  state.filters = defaultFilters();
  state.pool = [];
  state.deck = [];
  state.current = null;
  state.picks = 0;
  state.pendingSlugs.clear();
  state.progress = null;
  state.translations.clear();
  state.translationPending.clear();
  state.translationRetryAt.clear();
  clearAllTranslationTimers();

  els.backdrop.classList.remove('is-on');
  els.backdrop.style.backgroundImage = '';
  els.userChip.classList.add('hidden');
  els.spotlight.innerHTML = '';
  els.emptyState.classList.add('hidden');
  els.pickBar.classList.remove('hidden');
  els.activeChips.innerHTML = '';
  showLoadError('');

  // Deliberate returns start with a clean field: the placeholder shows, and
  // previous usernames are one click away in the datalist, not pre-typed.
  els.username.value = '';
  setView('landing');
  writeHash();
  // Quietly warm the last-used source while the user decides (see above).
  schedulePrefetch();
  els.username.focus({ preventScroll: true });
}

function showLoading() {
  setView('loading');
  els.loadError.hidden = true;
  els.loadingTitle.textContent = t('loading.title');
  els.loadingSub.textContent = t('loading.subMulti');
  els.progressFill.style.width = '4%';
  els.progressCount.textContent = t('loading.starting');
}

function showApp() {
  setView('app');
  const src = parseSourceId(state.username);
  if (src.kind === 'list') {
    // For lists the slug is the readable name; the owner shows in the kicker.
    els.userChip.textContent = t('user.listChip', { name: src.slug });
    els.usernameOut.textContent = src.slug;
    els.kickerPrefix.textContent = t('app.kickerListPrefix');
    els.kickerSuffix.textContent = t('app.kickerListSuffix', {
      owner: src.owner,
      total: state.total.toLocaleString(),
    });
  } else {
    const name = state.username === 'demo' ? 'demo' : state.username;
    els.userChip.textContent = `@${name}`;
    els.usernameOut.textContent = name;
    els.kickerPrefix.textContent = t('app.kickerPrefix');
    els.kickerSuffix.textContent = t('app.kickerSuffix', { total: state.total.toLocaleString() });
  }
  els.userChip.classList.remove('hidden');
}

function showEmpty() {
  els.spotlight.innerHTML = '';
  els.emptyState.classList.remove('hidden');
  els.pickBar.classList.add('hidden');
  els.pickNote.textContent = '';
  els.backdrop.classList.remove('is-on');
}

function hideEmpty() {
  els.emptyState.classList.add('hidden');
  els.pickBar.classList.remove('hidden');
}

/* ── URL hash ────────────────────────────────────────────── */

function splitList(value) {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const genres = splitList(params.get('g'));
  // Only genres are multi-select; older links that carry several decades or
  // countries keep the first value instead of silently restoring multi-select.
  const decades = splitList(params.get('d'))
    .map((entry) => clampDecade(entry))
    .filter(Boolean)
    .slice(0, 1);
  const countries = splitList(params.get('c')).slice(0, 1);

  return {
    username: normalizeInput(params.get('u') || ''),
    filters: {
      genres: new Set(genres),
      genreMode: params.get('m') === 'all' ? 'all' : 'any',
      rating: clampRating(Number(params.get('r') || 0)),
      runtime: clampRuntime(Number(params.get('rt') || 0)),
      decades: new Set(decades),
      countries: new Set(countries),
    },
  };
}

function writeHash() {
  if (state.view !== 'app' || !state.username) {
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  const params = new URLSearchParams();
  params.set('u', state.username);
  if (state.filters.genres.size) params.set('g', [...state.filters.genres].join(','));
  if (state.filters.genreMode === 'all') params.set('m', 'all');
  if (state.filters.rating) params.set('r', String(state.filters.rating));
  if (state.filters.runtime) params.set('rt', String(state.filters.runtime));
  if (state.filters.decades.size) {
    params.set('d', [...state.filters.decades].sort((a, b) => a - b).join(','));
  }
  if (state.filters.countries.size) params.set('c', [...state.filters.countries].join(','));

  history.replaceState(null, '', `#${params.toString()}`);
}

/* ── Filters ─────────────────────────────────────────────── */

function activeFilterCount() {
  return (
    state.filters.genres.size +
    (state.filters.rating ? 1 : 0) +
    (state.filters.runtime ? 1 : 0) +
    state.filters.decades.size +
    state.filters.countries.size
  );
}

function matchesFilters(film) {
  const { genres, genreMode, rating, runtime, decades, countries } = state.filters;

  if (rating > 0 && typeof film.rating === 'number' && film.rating + 1e-9 < rating) {
    return false;
  }

  // Films without a known runtime stay in the pool, matching how unrated films
  // are treated, so missing metadata never silently hides a title.
  if (runtime > 0 && typeof film.runtime === 'number' && film.runtime > runtime) {
    return false;
  }

  if (decades.size) {
    const filmDecade = film.year ? Math.floor(film.year / 10) * 10 : 0;
    if (!filmDecade || !decades.has(filmDecade)) return false;
  }

  if (countries.size) {
    const names = film.countries || [];
    if (!names.some((name) => countries.has(name))) return false;
  }

  if (genres.size) {
    const names = (film.genres || []).map((genre) => genre.name);
    if (genreMode === 'all') {
      for (const genre of genres) {
        if (!names.includes(genre)) return false;
      }
    } else if (!names.some((name) => genres.has(name))) {
      return false;
    }
  }

  return true;
}

function computePool() {
  state.pool = state.films.filter(matchesFilters);
  els.matchCount.textContent = state.pool.length.toLocaleString();
  els.poolLabel.textContent = t(state.pool.length === 1 ? 'app.poolOne' : 'app.poolMany');
  return state.pool;
}

function computeFacets() {
  const genres = new Map();
  const countries = new Map();
  const decades = new Map();
  let maxRuntime = 0;
  let withMetadata = 0;

  for (const film of state.films) {
    if (film.metaComplete) withMetadata += 1;
    if (film.year) {
      const decade = Math.floor(film.year / 10) * 10;
      if (decade > 0) decades.set(decade, (decades.get(decade) || 0) + 1);
    }
    for (const genre of film.genres || []) {
      if (genre?.name) genres.set(genre.name, (genres.get(genre.name) || 0) + 1);
    }
    for (const country of film.countries || []) {
      countries.set(country, (countries.get(country) || 0) + 1);
    }
    if (typeof film.runtime === 'number' && film.runtime > maxRuntime) maxRuntime = film.runtime;
  }

  const sorted = (map) =>
    [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const decadeList = [...decades.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => b.year - a.year);

  // The slider ends at the longest film in the list, rounded up to 30 minutes
  // and capped so one outlier (a miniseries, say) does not squash the track.
  const runtimeMax = maxRuntime > 0 ? Math.min(RUNTIME_SLIDER_MAX, Math.max(120, Math.ceil(maxRuntime / 30) * 30)) : 0;

  state.facets = {
    genres: sorted(genres),
    countries: sorted(countries),
    decades: decadeList,
    runtimeMax,
    withMetadata,
  };
}

function renderFacets() {
  const { genres, countries, decades, runtimeMax } = state.facets;

  if (!genres.length) {
    els.genreChips.innerHTML = `<p class="filter-note">${esc(t('app.noGenres'))}</p>`;
  } else {
    els.genreChips.innerHTML = genres
      .map(
        (genre) =>
          `<button class="chip" type="button" data-genre="${esc(genre.name)}" aria-pressed="false">${esc(
            tGenre(genre.name)
          )} <span class="n">${genre.count}</span></button>`
      )
      .join('');
  }

  // The runtime track is sized from this list, so a short watchlist still uses
  // the full width instead of clustering at the left edge.
  const hasRuntime = runtimeMax > 0;
  els.runtimeSlider.classList.toggle('hidden', !hasRuntime);
  els.runtimeEmpty.classList.toggle('hidden', hasRuntime);
  els.runtimeRange.disabled = !hasRuntime;
  if (hasRuntime) {
    els.runtimeRange.max = String(runtimeMax);
    els.runtimeScaleMax.textContent = formatRuntime(runtimeMax);
    if (state.filters.runtime > runtimeMax) state.filters.runtime = runtimeMax;
  } else {
    state.filters.runtime = 0;
    els.runtimeScaleMax.textContent = '';
  }

  els.decadeChips.innerHTML =
    `<button class="chip" type="button" data-decade="0" aria-pressed="false">${esc(t('app.any'))}</button>` +
    decades
      .map(
        (decade) =>
          `<button class="chip" type="button" data-decade="${decade.year}" aria-pressed="false">${esc(
            t('app.decadeChip', { year: decade.year })
          )} <span class="n">${decade.count}</span></button>`
      )
      .join('');

  els.countryChips.innerHTML =
    `<button class="chip" type="button" data-country="" aria-pressed="false">${esc(t('app.any'))}</button>` +
    countries
      .map(
        (country) =>
          `<button class="chip" type="button" data-country="${esc(
            country.name
          )}" aria-pressed="false">${esc(tCountry(country.name))} <span class="n">${country.count}</span></button>`
      )
      .join('');

  const decadeYears = new Set(decades.map((decade) => decade.year));
  for (const decade of [...state.filters.decades]) {
    if (!decadeYears.has(decade)) state.filters.decades.delete(decade);
  }

  const countryNames = new Set(countries.map((country) => country.name));
  for (const country of [...state.filters.countries]) {
    if (!countryNames.has(country)) state.filters.countries.delete(country);
  }
}

function updateFilterSummaries() {
  const setSummary = (element, text, active) => {
    element.textContent = text;
    element.classList.toggle('is-set', active);
  };

  setSummary(
    els.genreSummary,
    state.filters.genres.size ? [...state.filters.genres].map(tGenre).join(', ') : t('app.any'),
    state.filters.genres.size > 0
  );
  setSummary(
    els.ratingSummary,
    state.filters.rating ? `★ ${state.filters.rating.toFixed(1)}+` : t('app.any'),
    state.filters.rating > 0
  );
  setSummary(
    els.runtimeSummary,
    state.filters.runtime
      ? t('app.upTo', { value: formatRuntime(state.filters.runtime) })
      : t('app.any'),
    state.filters.runtime > 0
  );
  setSummary(
    els.decadeSummary,
    state.filters.decades.size
      ? [...state.filters.decades]
          .sort((a, b) => a - b)
          .map((decade) => t('app.decadeChip', { year: decade }))
          .join(', ')
      : t('app.any'),
    state.filters.decades.size > 0
  );
  setSummary(
    els.countrySummary,
    state.filters.countries.size ? [...state.filters.countries].map(tCountry).join(', ') : t('app.any'),
    state.filters.countries.size > 0
  );

  const count = activeFilterCount();
  setSummary(
    els.filterPanelState,
    count ? t(count === 1 ? 'app.activeOne' : 'app.activeMany', { count }) : '',
    count > 0
  );
}

function openActiveFilterSections() {
  const active = {
    genre: state.filters.genres.size > 0,
    rating: state.filters.rating > 0,
    runtime: state.filters.runtime > 0,
    decade: state.filters.decades.size > 0,
    country: state.filters.countries.size > 0,
  };

  $$('details.filter-block', els.filterBody).forEach((details) => {
    if (active[details.dataset.filter]) details.open = true;
  });

  if (activeFilterCount() > 0) els.filterPanel.open = true;
}

// Paint a slider from state: value, filled track width, and the text shown both
// in the open section and to screen readers.
function syncRange(input, output, value, { text, active }) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 0;
  // The "any" state (0) sits at the first stop of the track, not at zero.
  const display = value > 0 ? value : min;
  const next = String(display);
  if (input.value !== next) input.value = next;

  const percent = max > min ? ((display - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
  input.setAttribute('aria-valuetext', text);

  output.textContent = text;
  output.classList.toggle('is-set', active);
}

function syncControls() {
  $$('[data-mode-for]').forEach((group) => {
    const current = state.filters[group.dataset.modeFor];
    $$('[data-mode-value]', group).forEach((button) => {
      const active = button.dataset.modeValue === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  });

  $$('.chip[data-genre]', els.genreChips).forEach((chip) => {
    const active = state.filters.genres.has(chip.dataset.genre);
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  });

  // Sliders own their own value + fill; the summary row shows the same value
  // when the section is collapsed.
  syncRange(els.ratingRange, els.ratingOutput, state.filters.rating, {
    text: state.filters.rating ? `★ ${state.filters.rating.toFixed(1)}+` : t('app.any'),
    active: state.filters.rating > 0,
  });
  syncRange(els.runtimeRange, els.runtimeOutput, state.filters.runtime, {
    text: state.filters.runtime
      ? t('app.upTo', { value: formatRuntime(state.filters.runtime) })
      : t('app.any'),
    active: state.filters.runtime > 0,
  });

  $$('.chip[data-decade]', els.decadeChips).forEach((chip) => {
    const value = Number(chip.dataset.decade);
    const active = value === 0 ? state.filters.decades.size === 0 : state.filters.decades.has(value);
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  });

  $$('.chip[data-country]', els.countryChips).forEach((chip) => {
    const value = chip.dataset.country;
    const active = value === '' ? state.filters.countries.size === 0 : state.filters.countries.has(value);
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  });

  updateFilterSummaries();
  renderActiveChips();
}

function renderActiveChips() {
  const chips = [];

  for (const genre of state.filters.genres) {
    chips.push(`<button class="active-chip" type="button" data-remove="genre" data-value="${esc(genre)}">${esc(
      tGenre(genre)
    )} <span class="x" aria-hidden="true">×</span></button>`);
  }
  if (state.filters.rating) {
    chips.push(
      `<button class="active-chip" type="button" data-remove="rating">★ ${state.filters.rating.toFixed(1)}+ <span class="x" aria-hidden="true">×</span></button>`
    );
  }
  if (state.filters.runtime) {
    chips.push(
      `<button class="active-chip" type="button" data-remove="runtime">${esc(
        t('app.upTo', { value: formatRuntime(state.filters.runtime) })
      )} <span class="x" aria-hidden="true">×</span></button>`
    );
  }
  for (const decade of [...state.filters.decades].sort((a, b) => a - b)) {
    chips.push(
      `<button class="active-chip" type="button" data-remove="decade" data-value="${decade}">${esc(
        t('app.decadeChip', { year: decade })
      )} <span class="x" aria-hidden="true">×</span></button>`
    );
  }
  for (const country of state.filters.countries) {
    chips.push(
      `<button class="active-chip" type="button" data-remove="country" data-value="${esc(
        country
      )}">${esc(tCountry(country))} <span class="x" aria-hidden="true">×</span></button>`
    );
  }

  els.activeChips.innerHTML = chips.join('');
}

function applyFilters({ repick = true } = {}) {
  if (!state.detailsComplete) {
    syncControls();
    writeHash();
    els.matchCount.textContent = state.total.toLocaleString();
    els.poolLabel.textContent = t(state.total === 1 ? 'app.poolOne' : 'app.poolMany');
    return;
  }

  const previousPool = state.pool;
  computePool();
  syncControls();
  writeHash();

  if (!state.pool.length) {
    showEmpty();
    announce(t('announce.noMatch'));
    return;
  }

  // Only reshuffle and pick again when the matched films actually changed.
  const samePool =
    previousPool.length === state.pool.length &&
    state.pool.every((film, index) => film.slug === previousPool[index].slug);

  hideEmpty();
  if (!samePool) state.deck = [];

  if (repick && !samePool) pickFilm();
  else updatePickNote();
}

function clearAllFilters() {
  state.filters = defaultFilters();
  applyFilters();
}

/* ── Deck and card ───────────────────────────────────────── */

function shuffle(entries) {
  const copy = entries.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function drawFilm() {
  if (!state.pool.length) return null;

  if (!state.deck.length) {
    state.deck = shuffle(state.pool);
    if (state.current && state.deck.length > 1 && state.deck[state.deck.length - 1].slug === state.current.slug) {
      [state.deck[0], state.deck[state.deck.length - 1]] = [state.deck[state.deck.length - 1], state.deck[0]];
    }
  }

  let film = state.deck.pop();
  if (film && state.current && state.pool.length > 1 && film.slug === state.current.slug) {
    const alternative = state.deck.findIndex((entry) => entry.slug !== state.current.slug);
    if (alternative >= 0) {
      const swap = state.deck[alternative];
      state.deck[alternative] = film;
      film = swap;
    }
  }
  return film || null;
}

function updatePickNote() {
  if (!state.detailsComplete) {
    els.pickNote.textContent = t('pick.noteLoading');
    return;
  }
  // The deck size / pick counter repeats what the page already shows, so the
  // note is only used for the temporary "details are loading" hint.
  els.pickNote.textContent = '';
}

function pickFilm() {
  // Picking is allowed while details are still loading: basic films draw with
  // a placeholder poster and renderCard() fetches full details on demand.
  const film = drawFilm();
  if (!film) {
    showEmpty();
    return;
  }

  hideEmpty();
  state.current = film;
  state.picks += 1;
  updatePickNote();

  // A deliberate new pick deserves a fresh translation attempt even if the
  // same film failed earlier and is still inside its backoff window.
  clearTranslationTimer(film.slug);
  state.translationRetryAt.delete(film.slug);
  state.translationAttempts.delete(film.slug);

  const existing = $('.film-card', els.spotlight);
  if (existing) {
    existing.classList.add('is-changing');
    setTimeout(() => {
      if (state.current === film && state.view === 'app') renderCard(film);
    }, 140);
  } else {
    renderCard(film);
  }

  const year = film.year ? ` (${film.year})` : '';
  announce(t('announce.picked', { title: film.title, year }));
}

function posterMarkup(film) {
  const title = `${film.title}${film.year ? ` (${film.year})` : ''}`;
  const poster = safeUrl(film.poster);

  if (poster) {
    return `<img src="${esc(poster)}" alt="${esc(
      t('pick.posterAlt', { title: film.title })
    )}" width="238" height="357" />`;
  }
  return `<div class="poster-placeholder">${esc(title)}</div>`;
}

function ratingMarkup(film) {
  if (typeof film.rating !== 'number' || film.rating <= 0) return '';
  return `<span class="rating-badge"><span class="star" aria-hidden="true">★</span> ${film.rating.toFixed(1)}</span>`;
}

function translatedOverview(film) {
  if (!I18N.isArabic() || !film) return '';
  return state.translations.get(film.slug) || '';
}

function renderCard(film) {
  if (!film) return;

  const link = safeUrl(film.link) || `https://letterboxd.com/film/${encodeURIComponent(film.slug)}/`;
  const meta = [];
  if (film.year) meta.push(`<span class="year">${film.year}</span>`);
  if (film.runtime) meta.push(esc(formatRuntime(film.runtime)));
  if (film.directors?.length) {
    // Latin names inside an Arabic sentence need bidi isolation, otherwise the
    // comma between them is laid out right-to-left and lands in the wrong spot.
    const names = film.directors
      .slice(0, 2)
      .map((name) => `<bdi>${esc(name)}</bdi>`)
      .join(', ');
    meta.push(t('pick.directedBy', { names }));
  }
  if (film.countries?.length) {
    const countries = film.countries.map(tCountry);
    const label =
      film.countries.length > 1
        ? t('pick.countryMore', { name: countries[0] })
        : countries[0];
    meta.push(`<span title="${esc(countries.join(', '))}">${esc(label)}</span>`);
  }

  const genres = (film.genres || [])
    .slice(0, 5)
    .map((genre) => `<span class="genre-tag">${esc(tGenre(genre.name))}</span>`)
    .join('');

  const translation = translatedOverview(film);
  const overviewText = translation || film.overview;
  const overview = overviewText
    ? `<p class="overview"${translation ? ' lang="ar" dir="rtl" title="' + esc(t('pick.translated')) + '"' : ''}>${esc(
        overviewText
      )}</p>`
    : `<p class="overview details-note">${
        film.metaComplete ? esc(t('pick.noSynopsis')) : esc(t('pick.readingDetails'))
      }</p>`;

  const detailsNote = film.metaComplete
    ? film.ratingCount
      ? t(film.ratingCount === 1 ? 'pick.ratingsOne' : 'pick.ratingsMany', {
          count: compactNumber(film.ratingCount),
        })
      : ''
    : t('pick.detailsLoading');

  els.spotlight.innerHTML = `
    <article class="film-card">
      <div class="poster-wrap">
        ${posterMarkup(film)}
        ${ratingMarkup(film)}
      </div>
      <div class="film-body">
        <p class="film-kicker">${esc(t('pick.tonight'))}</p>
        <h2 class="film-title">${esc(film.title)}</h2>
        ${meta.length ? `<p class="film-meta">${meta.join('<span class="dot">·</span>')}</p>` : ''}
        ${genres ? `<div class="genre-row">${genres}</div>` : ''}
        ${overview}
        <div class="card-actions">
          <a class="btn ghost letterboxd" href="${esc(link)}" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path>
            </svg>
            ${esc(t('pick.viewOn'))}
          </a>
          <div class="share-wrap">
            <button
              class="btn ghost share-btn"
              type="button"
              data-share-toggle
              aria-expanded="false"
              aria-label="${esc(t('share.title'))}"
              title="${esc(t('share.title'))}"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"></path>
              </svg>
            </button>
            <div class="share-menu hidden">
              <button type="button" data-share="post">${esc(t('share.post'))}<span class="ratio">4:5</span></button>
              <button type="button" data-share="story">${esc(t('share.story'))}<span class="ratio">9:16</span></button>
            </div>
          </div>
          <span class="details-note">${esc(detailsNote)}</span>
        </div>
      </div>
    </article>
  `;

  const image = $('img', els.spotlight);
  if (image) {
    image.addEventListener(
      'error',
      () => {
        const placeholder = document.createElement('div');
        placeholder.className = 'poster-placeholder';
        placeholder.textContent = `${film.title}${film.year ? ` (${film.year})` : ''}`;
        image.replaceWith(placeholder);
      },
      { once: true }
    );
  }

  const art = safeUrl(film.backdrop) || safeUrl(film.poster);
  if (art) {
    els.backdrop.style.backgroundImage = `url("${art.replace(/"/g, '%22')}")`;
    els.backdrop.classList.add('is-on');
  } else {
    els.backdrop.classList.remove('is-on');
    els.backdrop.style.backgroundImage = '';
  }

  if (!film.metaComplete) ensureDetails(film);
  else ensureArabicOverview(film);
}

function clearTranslationTimer(slug) {
  const timer = state.translationTimers.get(slug);
  if (timer) clearTimeout(timer);
  state.translationTimers.delete(slug);
}

function clearAllTranslationTimers() {
  for (const timer of state.translationTimers.values()) clearTimeout(timer);
  state.translationTimers.clear();
  state.translationAttempts.clear();
}

function scheduleTranslationRetry(film) {
  const attempts = (state.translationAttempts.get(film.slug) || 0) + 1;
  state.translationAttempts.set(film.slug, attempts);

  const delay =
    TRANSLATION_RETRY_STEPS[Math.min(attempts - 1, TRANSLATION_RETRY_STEPS.length - 1)];
  state.translationRetryAt.set(film.slug, Date.now() + delay);

  clearTranslationTimer(film.slug);
  const timer = setTimeout(() => {
    state.translationTimers.delete(film.slug);
    if (!I18N.isArabic() || state.view !== 'app' || state.current?.slug !== film.slug) return;
    if (state.translations.has(film.slug)) return;
    ensureArabicOverview(film);
  }, delay);
  state.translationTimers.set(film.slug, timer);
}

async function ensureArabicOverview(film) {
  if (!I18N.isArabic() || !film || !film.slug || !film.overview) return;
  if (state.translations.has(film.slug) || state.translationPending.has(film.slug)) return;

  const retryAt = state.translationRetryAt.get(film.slug) || 0;
  if (Date.now() < retryAt) return;

  state.translationPending.add(film.slug);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

  try {
    const response = await fetch(
      `/api/translate?lang=ar&q=${encodeURIComponent(film.overview)}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal }
    );
    if (!response.ok) throw new Error('Translation unavailable');

    const data = await response.json();
    if (!data || typeof data.text !== 'string' || !data.text.trim()) {
      throw new Error('Translation unavailable');
    }

    state.translations.set(film.slug, data.text.trim());
    state.translationRetryAt.delete(film.slug);
    state.translationAttempts.delete(film.slug);
    clearTranslationTimer(film.slug);

    if (I18N.isArabic() && state.current?.slug === film.slug && state.view === 'app') {
      const node = $('.overview', els.spotlight);
      if (node && node.classList.contains('details-note') === false) {
        node.textContent = data.text.trim();
        node.setAttribute('lang', 'ar');
        node.setAttribute('dir', 'rtl');
        node.setAttribute('title', t('pick.translated'));
      }
    }
  } catch {
    // Keep the English synopsis for now and retry with backoff while this film
    // is on screen. It also retries immediately on the next pick or language
    // switch, so a temporary provider hiccup never becomes permanent.
    scheduleTranslationRetry(film);
  } finally {
    clearTimeout(timer);
    state.translationPending.delete(film.slug);
  }
}

async function ensureDetails(film) {
  if (!film || film.metaComplete || state.pendingSlugs.has(film.slug)) return;
  state.pendingSlugs.add(film.slug);

  try {
    const response = await fetch(`/api/film/${encodeURIComponent(film.slug)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Film details unavailable');
    const full = await response.json();
    if (!full || !full.slug) throw new Error('Film details unavailable');

    const index = state.films.findIndex((entry) => entry.slug === full.slug);
    if (index >= 0) state.films[index] = { ...state.films[index], ...full };
    const merged = index >= 0 ? state.films[index] : full;
    state.filmBySlug.set(full.slug, merged);

    if (state.current?.slug === full.slug) {
      state.current = merged;
      if (!state.detailsComplete) {
        renderCard(merged);
      } else if (matchesFilters(merged)) {
        renderCard(merged);
      } else {
        computePool();
        if (state.pool.length) pickFilm();
        else showEmpty();
      }
    }

    if (state.detailsComplete) {
      computeFacets();
      renderFacets();
      syncControls();
      computePool();
    }
  } catch {
    if (state.current?.slug === film.slug) {
      const note = $('.details-note', els.spotlight);
      if (note) note.textContent = t('pick.detailsUnavailable');
    }
  } finally {
    state.pendingSlugs.delete(film.slug);
  }
}

/* ── Server events ───────────────────────────────────────── */

function stopSource() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  if (state.networkTimer) {
    clearTimeout(state.networkTimer);
    state.networkTimer = null;
  }
  if (state.keepaliveTimer) {
    clearInterval(state.keepaliveTimer);
    state.keepaliveTimer = null;
  }
}

/* ── Username history ────────────────────────────────────── */

function loadUserHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_HISTORY_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw)]
      .filter((entry) => typeof entry === 'string' && isValidSource(entry))
      .slice(0, USER_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function renderUserSuggestions(history = loadUserHistory()) {
  els.userSuggestions.replaceChildren(
    ...history.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    })
  );
}

function saveUserToHistory(username) {
  const history = [username, ...loadUserHistory().filter((entry) => entry !== username)]
    .slice(0, USER_HISTORY_LIMIT);
  try {
    localStorage.setItem(USER_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage can be unavailable; suggestions are optional.
  }
  renderUserSuggestions(history);
}

/* ── Landing prefetch ────────────────────────────────────── */

// While the user sits on the landing page, quietly fetch the last-used source
// from the server's cache-only endpoint. On a hit, their next search paints
// the full app instantly — no stream, no loading screen. The endpoint never
// triggers a scrape (a miss is a plain 404 NOT_CACHED), so prefetching is
// free, and a cold source simply falls through to the normal stream path.
function schedulePrefetch() {
  cancelPrefetch();
  const last = loadUserHistory()[0];
  if (!last || last === 'demo') return;
  state.prefetchTimer = setTimeout(async () => {
    state.prefetchTimer = null;
    const controller = new AbortController();
    state.prefetchController = controller;
    try {
      const res = await fetch(`/api/watchlist/${encodeURIComponent(last)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) return;
      const payload = await res.json();
      if (payload?.detailsComplete) state.prefetched = { sourceId: last, payload };
    } catch {
      // Aborted or a network hiccup — the stream path still works.
    } finally {
      if (state.prefetchController === controller) state.prefetchController = null;
    }
  }, 600);
}

function cancelPrefetch() {
  if (state.prefetchTimer) {
    clearTimeout(state.prefetchTimer);
    state.prefetchTimer = null;
  }
  if (state.prefetchController) {
    state.prefetchController.abort();
    state.prefetchController = null;
  }
  state.prefetched = null;
}

function loadUser(rawSource, { filters } = {}) {
  const sourceId = normalizeInput(rawSource || '');
  if (!sourceId) {
    showLoadError(t('error.inputEmpty'), 'error.inputEmpty');
    els.username.focus();
    return;
  }
  if (!isValidSource(sourceId)) {
    showLoadError(t('error.inputInvalid'), 'error.inputInvalid');
    els.username.focus();
    return;
  }

  stopSource();
  showLoadError('');
  els.username.value = sourceId;
  if (sourceId !== 'demo') saveUserToHistory(sourceId);

  state.username = sourceId;
  state.films = [];
  state.filmBySlug = new Map();
  state.total = 0;
  state.detailsComplete = false;
  state.rejoins = 0;
  state.facets = { genres: [], countries: [], decades: [], runtimeMax: 0, withMetadata: 0 };
  state.filters = filters || defaultFilters();
  state.pool = [];
  state.deck = [];
  state.current = null;
  state.picks = 0;
  state.pendingSlugs.clear();
  state.progress = null;
  state.translations.clear();
  state.translationPending.clear();
  state.translationRetryAt.clear();
  clearAllTranslationTimers();

  // A new search starts the way a page refresh would: filters back to their
  // defaults in the UI sense too — panel and every criterion block collapsed,
  // so no session inherits the previous one's open state.
  els.filterPanel.open = false;
  $$('details.filter-block[open]', els.filterBody).forEach((block) => {
    block.open = false;
  });

  els.backdrop.classList.remove('is-on');
  els.backdrop.style.backgroundImage = '';
  els.spotlight.innerHTML = '';
  els.emptyState.classList.add('hidden');
  els.pickBar.classList.remove('hidden');
  els.activeChips.innerHTML = '';
  els.detailsStrip.classList.remove('hidden');
  els.detailsFill.style.width = '0%';
  els.detailsText.textContent = t('app.detailsInitial');

  // Consume a landing prefetch when the user re-searched the exact source it
  // fetched: the full details-complete payload is already in memory, so the
  // app paints instantly instead of streaming through the loading screen.
  const prefetched = state.prefetched;
  cancelPrefetch();
  if (
    sourceId !== 'demo' &&
    prefetched?.sourceId === sourceId &&
    prefetched.payload?.detailsComplete
  ) {
    handleDone({ cached: true, ...prefetched.payload });
    return;
  }

  setView('loading');
  showLoading();

  state.rejoins = 0;
  state.source = wireSource(sourceId);
}

/* ── Stream wiring ────────────────────────────────────────── */

// One EventSource with the full stream wiring, shared by a fresh load and
// a mid-flight rejoin: the server replays films + progress to any joining
// tab, so recovering from a dropped connection needs no state reset.
function wireSource(sourceId) {
  const source = new EventSource(`/api/watchlist/${encodeURIComponent(sourceId)}/stream`);

  // While details are still enriching, feed the host's activity monitor a
  // cheap incoming request every few minutes. Render's free plan counts
  // only incoming requests as activity and spins an "idle" instance down
  // mid-stream — the connection then dies and the job must be rejoined.
  if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
  state.keepaliveTimer = setInterval(() => {
    if (!state.detailsComplete) fetch('/api/health', { cache: 'no-store' }).catch(() => {});
  }, 5 * 60 * 1000);

  source.addEventListener('open', () => {
    state.rejoins = 0;
    if (state.networkTimer) {
      clearTimeout(state.networkTimer);
      state.networkTimer = null;
    }
  });

  source.addEventListener('progress', (event) => {
    try {
      handleProgress(JSON.parse(event.data));
    } catch {
      // Ignore malformed progress frames.
    }
  });

  source.addEventListener('films', (event) => {
    try {
      handleFilms(JSON.parse(event.data));
    } catch {
      // Ignore malformed payloads; the done frame will recover.
    }
  });

  source.addEventListener('more', (event) => {
    if (state.source !== source) return;
    try {
      handleMoreFilms(JSON.parse(event.data));
    } catch {
      // Ignore malformed delta frames; the final snapshot recovers.
    }
  });

  source.addEventListener('pick', (event) => {
    if (state.source !== source) return;
    try {
      const film = JSON.parse(event.data)?.pick;
      if (!film?.slug) return;
      // Swap the basic entry for the fully read one wherever it lives, and
      // refresh the card if it is the one on screen.
      const index = state.films.findIndex((f) => f.slug === film.slug);
      if (index >= 0) state.films[index] = film;
      state.filmBySlug.set(film.slug, film);
      if (state.current?.slug === film.slug) renderCard(film);
    } catch {
      // Ignore malformed frames.
    }
  });

  source.addEventListener('done', (event) => {
    if (state.source !== source) return;
    try {
      handleDone(JSON.parse(event.data));
    } catch {
      stopSource();
      showLoadError(t('error.loadFailed'), 'error.loadFailed');
      setView('landing');
    }
  });

  source.addEventListener('error', (event) => {
    if (state.source !== source) return;

    // A server-sent "error" event carries data; a transport error does not.
    if (event.data) {
      let parsed = { message: '' };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // Keep the fallback message.
      }
      const errorKey = serverErrorKey(parsed);
      const message = (errorKey && t(errorKey)) || parsed.message || t('error.couldNotLoad');
      stopSource();
      if (state.view === 'app') {
        toast(message);
      } else {
        showLoadError(message, errorKey);
        setView('landing');
      }
      return;
    }

    // Transport dropped. Everything already loaded stays usable, and the
    // enrichment job keeps running server-side — throwing the user back to
    // the landing page would discard a working pick. The grace period
    // covers slow recoveries (an instance restarting, wake from sleep).
    const inAppEnrichment = state.view === 'app' && !state.detailsComplete;

    // CLOSED means the browser gave up for good — typically a non-200
    // reply (bad username, or a proxy 502 while the instance restarts).
    if (source.readyState === EventSource.CLOSED) {
      stopSource();
      if (inAppEnrichment) {
        if ((state.rejoins || 0) < 5) {
          // Rejoin: a fresh stream replays films + progress and the job
          // resumes enriching without touching the current pick.
          state.rejoins += 1;
          toast(t('toast.retry'));
          state.networkTimer = setTimeout(() => {
            if (state.view === 'app' && !state.detailsComplete && !state.source) {
              state.source = wireSource(state.username);
            }
          }, 2000);
        } else {
          els.detailsStrip.classList.add('hidden');
          toast(t('app.detailsOffline'));
        }
        return;
      }
      showLoadError(t('error.couldNotLoad'), 'error.couldNotLoad');
      setView('landing');
      return;
    }

    // Not CLOSED: EventSource is retrying behind the scenes, and the
    // `open` handler clears this timer the moment the connection returns.
    if ((state.view === 'loading' || inAppEnrichment) && !state.networkTimer) {
      toast(t('toast.retry'));
      state.networkTimer = setTimeout(() => {
        if (state.view === 'loading') {
          stopSource();
          showLoadError(t('error.serverDown'), 'error.serverDown');
          setView('landing');
        } else if (state.view === 'app' && !state.detailsComplete) {
          stopSource();
          els.detailsStrip.classList.add('hidden');
          toast(t('app.detailsOffline'));
        }
      }, 30000);
    }
  });

  return source;
}

function handleProgress(progress) {
  if (!progress || !progress.phase) return;
  state.progress = progress;

  if (progress.phase === 'watchlist') {
    const pagesTotal = Math.max(1, Number(progress.pagesTotal) || 1);
    const page = Math.min(pagesTotal, Number(progress.page) || 1);
    const percent = Math.max(4, Math.min(100, (page / pagesTotal) * 100));

    els.progressFill.style.width = `${percent}%`;
    els.loadingTitle.textContent = t('loading.title');
    els.loadingSub.textContent = pagesTotal > 1 ? t('loading.subMulti') : t('loading.subSingle');
    els.progressCount.textContent = t(pagesTotal > 1 ? 'loading.pageMany' : 'loading.pageOne', {
      page,
      total: pagesTotal,
      films: Number(progress.filmsFound || 0).toLocaleString(),
    });
    return;
  }

  if (progress.phase === 'details') {
    const total = Math.max(1, Number(progress.total) || state.total || 1);
    const completed = Math.min(total, Number(progress.completed) || 0);
    const percent = Math.min(100, (completed / total) * 100);

    state.details = { completed, total, failed: Number(progress.failed) || 0 };

    els.detailsFill.style.width = `${percent}%`;
    els.detailsText.textContent = t('app.detailsReading', { done: completed, total });

    if (state.view === 'loading') {
      els.progressFill.style.width = `${Math.max(4, percent)}%`;
      els.loadingTitle.textContent = t('loading.detailsTitle');
      els.loadingSub.textContent = t('loading.detailsSub');
      els.progressCount.textContent = t('loading.filmsCount', { done: completed, total });
    }
  }
}

function handleFilms(payload) {
  if (!payload || !Array.isArray(payload.films)) return;

  state.films = payload.films;
  state.filmBySlug = new Map(state.films.map((film) => [film.slug, film]));
  state.total = Number(payload.total) || state.films.length;
  state.detailsComplete = false;
  // A mid-flight rejoin replaces the film array, so any deck left over from a
  // previous attempt holds dead basic-film objects. Drop it before first draw.
  state.deck = [];

  showApp();
  hideEmpty();

  els.detailsStrip.classList.remove('hidden');
  els.detailsText.textContent = t('app.detailsPreparing');
  els.detailsFill.style.width = '0%';
  els.filterLoading.classList.remove('hidden');
  els.filterBody.classList.add('hidden');
  els.filterUnavailable.classList.add('hidden');

  els.matchCount.textContent = state.total.toLocaleString();
  els.poolLabel.textContent = t(state.total === 1 ? 'app.poolOne' : 'app.poolMany');

  const initial = payload.pick || state.films[0] || null;
  // Progressive loads re-emit as list pages arrive: draw only the first card,
  // and never yank a film the user already chose mid-load. Rejoins likewise
  // redraw only when nothing is on screen yet.
  if (initial && !state.current) {
    state.current = initial;
    state.picks = 1;
    renderCard(initial);
    announce(t('announce.loaded', { total: state.total }));
  }

  updatePickNote();
  writeHash();
}

function handleMoreFilms(payload) {
  if (!payload || !Array.isArray(payload.films) || !payload.films.length) return;

  // Progressive delta frame: append only films the client doesn't hold yet.
  // (The server dedupes too, but a frame racing the final snapshot can
  // overlap, and deduping here is one Set lookup.)
  for (const film of payload.films) {
    if (!state.filmBySlug.has(film.slug)) {
      state.films.push(film);
      state.filmBySlug.set(film.slug, film);
    }
  }
  state.total = Number(payload.total) || state.films.length;

  els.matchCount.textContent = state.total.toLocaleString();
  els.poolLabel.textContent = t(state.total === 1 ? 'app.poolOne' : 'app.poolMany');
  updatePickNote();
}

function handleDone(payload) {
  if (!payload || !Array.isArray(payload.films)) return;
  stopSource();

  state.films = payload.films;
  state.filmBySlug = new Map(state.films.map((film) => [film.slug, film]));
  state.total = Number(payload.total) || state.films.length;
  state.detailsComplete = true;

  showApp();
  els.detailsStrip.classList.add('hidden');

  computeFacets();
  renderFacets();

  if (state.facets.withMetadata === 0 && state.films.length) {
    els.filterLoading.classList.add('hidden');
    els.filterBody.classList.add('hidden');
    els.filterUnavailable.classList.remove('hidden');
  } else {
    els.filterUnavailable.classList.add('hidden');
    els.filterLoading.classList.add('hidden');
    els.filterBody.classList.remove('hidden');
  }

  syncControls();
  openActiveFilterSections();
  computePool();
  // Picks made during the details phase drew from a deck of basic films; the
  // freshly computed pool supersedes it, so the next pick starts a clean deck.
  state.deck = [];
  hideEmpty();

  const enrichedCurrent = state.current ? state.filmBySlug.get(state.current.slug) : null;
  const candidate = enrichedCurrent;

  if (candidate) {
    state.current = candidate;
    state.picks = Math.max(1, state.picks);
  }

  const filtersActive = activeFilterCount() > 0;
  const currentMatches = candidate ? matchesFilters(candidate) : false;

  if (!state.pool.length) {
    showEmpty();
  } else if (!candidate || filtersActive || !currentMatches) {
    // Cached and demo payloads arrive without a first-phase pick, so choose a
    // fresh random film rather than replaying whatever was cached last time.
    state.deck = [];
    pickFilm();
  } else {
    renderCard(candidate);
    updatePickNote();
  }

  writeHash();
  announce(t('announce.ready', { count: state.pool.length }));
}

/* ── Share image ─────────────────────────────────────────────
   Draws the picked film as a ready-to-post PNG (4:5 for feeds, 9:16 for
   stories) on a canvas, the way X's "Screenshot" share option does for
   posts. Posters are loaded through the server's /api/poster route because
   Letterboxd's image CDN sends no CORS headers, and a canvas that has drawn
   a cross-origin image refuses to export. */

// Flip together with the canonical / og:url change in index.html once the
// custom domain is attached.
const SHARE_SITE_HOST = 'tonights-movie.onrender.com';
const SHARE_FONT = '"IBM Plex Sans Arabic", "Segoe UI", Tahoma, "Noto Sans Arabic", Arial, sans-serif';
const SHARE_FORMATS = {
  post: { w: 1080, h: 1350, top: 84, poster: 380, title: 58, meta: 30, chip: 26, body: 30, titleLines: 2, bodyLines: 4, bottom: 70 },
  // Stories keep ~250px clear top and bottom for the app's own UI.
  story: { w: 1080, h: 1920, top: 200, poster: 480, title: 72, meta: 36, chip: 30, body: 36, titleLines: 3, bodyLines: 5, bottom: 250 },
};
const SHARE_BRAND_HEIGHT = 84;
const shareBlobs = new Map();

function shareDir(text) {
  return /[\u0590-\u08FF]/.test(String(text || '')) ? 'rtl' : 'ltr';
}

function shareRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function shareLoadImage(source) {
  return new Promise((resolve) => {
    if (!source) {
      resolve(null);
      return;
    }
    let src;
    try {
      const url = new URL(source, location.href);
      src = url.origin === location.origin ? url.href : `/api/poster?u=${encodeURIComponent(url.href)}`;
    } catch {
      resolve(null);
      return;
    }
    const image = new Image();
    const timer = setTimeout(() => resolve(null), 9000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = src;
  });
}

function shareFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function shareWrap(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || maxLines < 1) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    // Whatever does not fit collapses into one last line that ends in "…".
    const overflow = lines.slice(maxLines - 1).join(' ');
    lines.length = maxLines - 1;
    lines.push(`${overflow}…`);
  }
  return lines.map((entry) => shareFit(ctx, entry, maxWidth));
}

function shareCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function shareBackground(ctx, w, h) {
  // Solid stage with the brand glow. An earlier version filled the canvas
  // with a blurred copy of the poster; it is gone on purpose.
  ctx.fillStyle = '#0c1014';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, h * 0.75);
  glow.addColorStop(0, 'rgba(0, 224, 84, 0.16)');
  glow.addColorStop(1, 'rgba(0, 224, 84, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

function shareStar(ctx, cx, cy, radius) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? radius : radius * 0.42;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function sharePoster(ctx, image, film, x, y, w, h) {
  const radius = Math.round(w * 0.045);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 24;
  shareRoundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = '#10151a';
  ctx.fill();
  ctx.restore();

  ctx.save();
  shareRoundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  if (image) {
    shareCover(ctx, image, x, y, w, h);
  } else {
    const fill = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
    fill.addColorStop(0, '#1b232c');
    fill.addColorStop(1, '#10151a');
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    const size = Math.round(w * 0.075);
    const label = `${film.title}${film.year ? ` (${film.year})` : ''}`;
    ctx.font = `700 ${size}px ${SHARE_FONT}`;
    ctx.direction = shareDir(label);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c2ccd6';
    const lines = shareWrap(ctx, label, w - 80, 6);
    const lh = Math.round(size * 1.3);
    let ty = y + h / 2 - ((lines.length - 1) * lh) / 2;
    for (const line of lines) {
      ctx.fillText(line, x + w / 2, ty);
      ty += lh;
    }
  }
  ctx.restore();

  shareRoundRect(ctx, x, y, w, h, radius);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (typeof film.rating === 'number' && film.rating > 0) {
    const size = Math.round(w * 0.058);
    const text = film.rating.toFixed(1);
    ctx.font = `700 ${size}px ${SHARE_FONT}`;
    ctx.direction = 'ltr';
    const padX = Math.round(size * 0.75);
    const starW = Math.round(size * 0.95);
    const pillW = padX * 2 + starW + Math.round(size * 0.35) + Math.ceil(ctx.measureText(text).width);
    const pillH = Math.round(size * 1.9);
    const inset = Math.round(w * 0.05);
    const px = I18N.isArabic() ? x + w - inset - pillW : x + inset;
    const py = y + h - inset - pillH;
    shareRoundRect(ctx, px, py, pillW, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
    shareStar(ctx, px + padX + starW / 2, py + pillH / 2, size * 0.5);
    ctx.fillStyle = '#f5c451';
    ctx.fill();
    ctx.fillStyle = '#eef2f5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px + padX + starW + Math.round(size * 0.35), py + pillH / 2 + 1);
  }
}

function shareChips(ctx, labels, cx, y, maxWidth, size, rtl) {
  ctx.font = `400 ${size}px ${SHARE_FONT}`;
  const padX = Math.round(size * 0.8);
  const height = Math.round(size * 2);
  const gap = Math.round(size * 0.5);
  const chips = [];
  let total = 0;
  for (const label of labels) {
    ctx.direction = shareDir(label);
    const width = Math.ceil(ctx.measureText(label).width) + padX * 2;
    const next = total + (chips.length ? gap : 0) + width;
    if (next > maxWidth) break;
    chips.push({ label, width });
    total = next;
  }
  if (!chips.length) return 0;

  let cursor = rtl ? cx + total / 2 : cx - total / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const chip of chips) {
    const left = rtl ? cursor - chip.width : cursor;
    shareRoundRect(ctx, left, y, chip.width, height, height / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#d3dce5';
    ctx.direction = shareDir(chip.label);
    ctx.fillText(chip.label, left + chip.width / 2, y + height / 2 + 1);
    cursor = rtl ? left - gap : left + chip.width + gap;
  }
  return height;
}

function shareBrand(ctx, cfg, rtl) {
  const cx = cfg.w / 2;
  const top = cfg.h - cfg.bottom - SHARE_BRAND_HEIGHT;
  const name = t('share.brand');
  ctx.font = `700 34px ${SHARE_FONT}`;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  const nameW = Math.ceil(ctx.measureText(name).width);
  const dotR = 10;
  const dotGap = 16;
  const groupW = nameW + dotGap + dotR * 2;
  const nameCx = rtl ? cx - groupW / 2 + nameW / 2 : cx + groupW / 2 - nameW / 2;
  const dotCx = rtl ? cx + groupW / 2 - dotR : cx - groupW / 2 + dotR;
  const dotCy = top + 20;

  const dot = ctx.createRadialGradient(dotCx - 3, dotCy - 3, 1, dotCx, dotCy, dotR);
  dot.addColorStop(0, '#b8ffd2');
  dot.addColorStop(0.55, '#00e054');
  dot.addColorStop(1, '#008a34');
  ctx.beginPath();
  ctx.arc(dotCx, dotCy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#eef2f5';
  ctx.fillText(name, nameCx, top + 20);

  ctx.font = `400 26px ${SHARE_FONT}`;
  ctx.direction = 'ltr';
  ctx.fillStyle = '#9aa7b4';
  ctx.fillText(SHARE_SITE_HOST, cx, top + 66);
}

async function renderShareCard(film, format) {
  const cfg = SHARE_FORMATS[format] || SHARE_FORMATS.post;
  const rtl = I18N.isArabic();
  const title = film.title || '';
  const overview = translatedOverview(film) || film.overview || '';

  const metaParts = [];
  if (film.year) metaParts.push(String(film.year));
  if (film.runtime) metaParts.push(formatRuntime(film.runtime));
  if (film.directors?.length) metaParts.push(t('pick.directedBy', { names: film.directors.slice(0, 2).join(', ') }));
  const metaText = metaParts.join('   ·   ');
  const genres = (film.genres || []).slice(0, 4).map((genre) => tGenre(genre.name));

  // Canvas text needs the web fonts to be loaded; ask for the exact glyphs
  // used so the right unicode-range subsets are fetched.
  const sample = `${title} ${metaText} ${genres.join(' ')} ${overview} ${t('share.brand')}`;
  const loadFont = (descriptor) => (document.fonts?.load ? document.fonts.load(descriptor, sample) : Promise.resolve());
  const fonts = Promise.all([
    loadFont('700 40px "IBM Plex Sans Arabic"'),
    loadFont('400 30px "IBM Plex Sans Arabic"'),
  ]).catch(() => {});
  const [image] = await Promise.all([shareLoadImage(film.poster), fonts]);

  const canvas = document.createElement('canvas');
  canvas.width = cfg.w;
  canvas.height = cfg.h;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  shareBackground(ctx, cfg.w, cfg.h);

  const posterW = cfg.poster;
  const posterH = Math.round(posterW * 1.5);
  const cx = cfg.w / 2;
  const maxW = cfg.w - 160;
  sharePoster(ctx, image, film, cx - posterW / 2, cfg.top, posterW, posterH);

  let y = cfg.top + posterH + Math.round(cfg.title * 0.9);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${cfg.title}px ${SHARE_FONT}`;
  ctx.direction = shareDir(title);
  ctx.fillStyle = '#eef2f5';
  const titleLh = Math.round(cfg.title * 1.2);
  for (const line of shareWrap(ctx, title, maxW, cfg.titleLines)) {
    ctx.fillText(line, cx, y + titleLh / 2);
    y += titleLh;
  }

  if (metaText) {
    y += Math.round(cfg.meta * 0.45);
    ctx.font = `400 ${cfg.meta}px ${SHARE_FONT}`;
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.fillStyle = '#c7d1db';
    const metaLh = Math.round(cfg.meta * 1.45);
    for (const line of shareWrap(ctx, metaText, maxW, 2)) {
      ctx.fillText(line, cx, y + metaLh / 2);
      y += metaLh;
    }
  }

  y += Math.round(cfg.chip * 0.9);
  const chipH = shareChips(ctx, genres, cx, y, maxW, cfg.chip, rtl);
  if (chipH) y += chipH + Math.round(cfg.body * 1.1);

  const bodyLh = Math.round(cfg.body * 1.5);
  const footerTop = cfg.h - cfg.bottom - SHARE_BRAND_HEIGHT - 28;
  const room = Math.min(cfg.bodyLines, Math.floor((footerTop - y) / bodyLh));
  if (overview && room >= 2) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `400 ${cfg.body}px ${SHARE_FONT}`;
    ctx.direction = shareDir(overview);
    ctx.fillStyle = 'rgba(238, 242, 245, 0.86)';
    for (const line of shareWrap(ctx, overview, maxW - 40, room)) {
      ctx.fillText(line, cx, y + bodyLh / 2);
      y += bodyLh;
    }
  }

  shareBrand(ctx, cfg, rtl);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The canvas could not be exported.');
  return { blob, complete: !film.poster || Boolean(image) };
}

// Renders are cached per film, size, language and synopsis, so choosing a size
// right after opening the menu (which warms both) can call navigator.share
// while the tap still counts as a user gesture — Safari requires that.
function getShareBlob(film, format) {
  const overview = translatedOverview(film) || film.overview || '';
  const key = [film.slug, format, I18N.isArabic() ? 'ar' : 'en', overview.length, film.poster ? 1 : 0].join('|');
  let promise = shareBlobs.get(key);
  if (!promise) {
    promise = renderShareCard(film, format).then(({ blob, complete }) => {
      // A card drawn without its poster (the load failed) is not worth keeping.
      if (!complete) shareBlobs.delete(key);
      return blob;
    });
    shareBlobs.set(key, promise);
    promise.catch(() => shareBlobs.delete(key));
    while (shareBlobs.size > 6) shareBlobs.delete(shareBlobs.keys().next().value);
  }
  return promise;
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

async function shareCurrentFilm(format) {
  const film = state.current;
  if (!film) return;
  const filename = `${film.slug}-${format}.png`;
  const pending = getShareBlob(film, format);

  let notified = false;
  const timer = setTimeout(() => {
    notified = true;
    toast(t('share.preparing'));
  }, 350);
  let blob;
  try {
    blob = await pending;
  } catch {
    clearTimeout(timer);
    toast(t('share.failed'));
    return;
  }
  clearTimeout(timer);
  if (notified) els.toast.classList.remove('is-on');

  const file = new File([blob], filename, { type: 'image/png' });
  const touch = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: film.title });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      // Any other failure falls through to a plain download.
    }
  }
  downloadBlob(blob, filename);
  toast(t('share.saved'));
}

function closeShareMenus({ restoreFocus = false } = {}) {
  $$('.share-menu:not(.hidden)', els.spotlight).forEach((menu) => {
    menu.classList.add('hidden');
    menu.style.transform = '';
    const toggle = $('[data-share-toggle]', menu.parentElement);
    toggle?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle?.focus();
  });
}

function toggleShareMenu(toggle) {
  const menu = $('.share-menu', toggle.parentElement);
  if (!menu) return;
  const opening = menu.classList.contains('hidden');
  closeShareMenus();
  if (!opening) return;
  menu.classList.remove('hidden');
  toggle.setAttribute('aria-expanded', 'true');
  // On narrow phones the popover is wider than the room beside its anchor,
  // which used to push it past the viewport and widen the page. Nudge it
  // back inside instead — the anchor never moves off-screen itself.
  const margin = 8;
  const edge = document.documentElement.clientWidth;
  const rect = menu.getBoundingClientRect();
  let shift = 0;
  if (rect.left < margin) shift = margin - rect.left;
  else if (rect.right > edge - margin) shift = edge - margin - rect.right;
  if (shift) menu.style.transform = `translateX(${shift.toFixed(1)}px)`;
  if (state.current) {
    // Warm both sizes so the next tap does not wait on the canvas.
    getShareBlob(state.current, 'post').catch(() => {});
    getShareBlob(state.current, 'story').catch(() => {});
  }
}

/* ── Events ──────────────────────────────────────────────── */

/* ── <details> open/close animation ───────────────────────── */

// Shared by the summary click and the F keyboard shortcut so both paths play
// the same motion (the keyboard path must not snap open or closed).
const detailsAnimations = new WeakMap();

function toggleDetailsAnimated(details) {
  const summary = details.querySelector(':scope > summary');
  const content = summary ? summary.nextElementSibling : null;
  if (!summary || !content) return;

  // Read per toggle so a mid-session preference change is honored.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const duration = 220;
  const easing = 'cubic-bezier(0.4, 0, 0.2, 1)';

  const current = detailsAnimations.get(details);
  const reopening = current ? current.mode === 'closing' : false;
  const opening = reopening || !details.open;

  // A closed <details> still reports a laid-out height for its content,
  // so start from zero when opening fresh.
  const startHeight = opening && !reopening ? 0 : content.getBoundingClientRect().height;

  if (current) current.animation.cancel();
  detailsAnimations.delete(details);
  details.classList.remove('is-collapsing');

  if (reduceMotion.matches) {
    details.open = opening;
    return;
  }

  if (opening) {
    details.open = true;
    const endHeight = content.getBoundingClientRect().height;
    const endPadding = parseFloat(getComputedStyle(content).paddingBottom) || 0;

    const animation = content.animate(
      [
        { height: `${startHeight}px`, paddingBottom: '0px', opacity: startHeight ? 1 : 0 },
        { height: `${endHeight}px`, paddingBottom: `${endPadding}px`, opacity: 1 },
      ],
      { duration, easing }
    );

    detailsAnimations.set(details, { animation, mode: 'opening' });

    const cleanup = () => {
      if (detailsAnimations.get(details)?.animation !== animation) return;
      detailsAnimations.delete(details);
    };

    animation.addEventListener('finish', cleanup);
    animation.addEventListener('cancel', cleanup);
    return;
  }

  details.classList.add('is-collapsing');

  const startPadding = parseFloat(getComputedStyle(content).paddingBottom) || 0;

  const animation = content.animate(
    [
      { height: `${startHeight}px`, paddingBottom: `${startPadding}px`, opacity: 1 },
      { height: '0px', paddingBottom: '0px', opacity: 0 },
    ],
    { duration, easing, fill: 'forwards' }
  );

  detailsAnimations.set(details, { animation, mode: 'closing' });

  let fallback = 0;

  const settle = () => {
    if (detailsAnimations.get(details)?.animation !== animation) return;
    clearTimeout(fallback);
    details.open = false;
    details.classList.remove('is-collapsing');
    detailsAnimations.delete(details);
    animation.cancel();
  };

  animation.addEventListener('finish', settle);
  animation.addEventListener('cancel', () => {
    clearTimeout(fallback);
    if (detailsAnimations.get(details)?.animation !== animation) return;
    details.classList.remove('is-collapsing');
  });

  fallback = setTimeout(settle, duration + 200);
}

function setupDetailsAnimation() {
  const sections = [els.filterPanel, ...$$('details.filter-block', els.filterBody)];

  sections.forEach((details) => {
    const summary = details.querySelector(':scope > summary');
    if (!summary) return;

    summary.addEventListener('click', (event) => {
      if (event.target.closest('.segmented')) return;
      event.preventDefault();
      toggleDetailsAnimated(details);
    });
  });
}

function refreshLanguage() {
  syncLanguageToggle();
  applyTheme(currentTheme(), { persist: false });

  if (state.errorKey) showLoadError(t(state.errorKey), state.errorKey);

  if (state.progress) handleProgress(state.progress);

  if (state.view === 'loading') {
    if (!state.progress) showLoading();
    return;
  }

  if (state.view !== 'app') return;

  showApp();

  if (state.detailsComplete) {
    computeFacets();
    renderFacets();
    computePool();
  }

  syncControls();
  updatePickNote();
  if (state.current) {
    // Switching to Arabic should retry a previously failed synopsis right
    // away instead of waiting out the backoff for the old language.
    if (I18N.isArabic()) {
      clearTranslationTimer(state.current.slug);
      state.translationRetryAt.delete(state.current.slug);
      state.translationAttempts.delete(state.current.slug);
    }
    renderCard(state.current);
  }
}

function bindEvents() {
  setupDetailsAnimation();

  // iOS Safari only paints :active states on elements when at least one
  // touch listener exists somewhere on the page — this empty one unlocks
  // the poster's press feedback there.
  document.addEventListener('touchstart', () => {}, { passive: true });

  I18N.onChange(refreshLanguage);

  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', () => {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
  }

  if (els.langToggle) {
    els.langToggle.addEventListener('click', () => {
      I18N.setLang(I18N.isArabic() ? 'en' : 'ar');
    });
  }

  if (els.shortcutsDialog) {
    els.shortcutsToggle?.addEventListener('click', toggleShortcutsDialog);
    els.shortcutsClose?.addEventListener('click', () => els.shortcutsDialog.close());
    // A click on the backdrop — anywhere outside the box — closes it too.
    els.shortcutsDialog.addEventListener('click', (event) => {
      if (event.target === els.shortcutsDialog) els.shortcutsDialog.close();
    });
    // Closing (Esc included) restores focus to the invoking chip, which would
    // light up its green focus ring. Drop that synthetic restore a frame later.
    els.shortcutsDialog.addEventListener('close', () => {
      requestAnimationFrame(() => {
        if (document.activeElement === els.shortcutsToggle) els.shortcutsToggle.blur();
      });
    });
  }

  els.loadForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadUser(els.username.value);
  });

  els.demoBtn.addEventListener('click', () => loadUser('demo'));

  els.cancelLoad.addEventListener('click', () => {
    stopSource();
    showLanding();
  });

  els.brandLink.addEventListener('click', (event) => {
    event.preventDefault();
    showLanding();
  });

  els.userChip.addEventListener('click', showLanding);

  els.genreChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip[data-genre]');
    if (!chip) return;
    const genre = chip.dataset.genre;
    if (state.filters.genres.has(genre)) state.filters.genres.delete(genre);
    else state.filters.genres.add(genre);
    applyFilters();
  });

  $$('[data-mode-for]').forEach((group) => {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode-value]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      state.filters[group.dataset.modeFor] = button.dataset.modeValue === 'all' ? 'all' : 'any';
      applyFilters();
    });
  });

  // Rating and runtime are sliders: dragging previews the pool count without
  // reshuffling the card, and releasing commits the filter and repicks.
  for (const [input, key] of [
    [els.ratingRange, 'rating'],
    [els.runtimeRange, 'runtime'],
  ]) {
    input.addEventListener('input', () => {
      const clamp = key === 'rating' ? clampRating : clampRuntime;
      const value = clamp(Number(input.value));
      if (value === state.filters[key]) return;
      state.filters[key] = value;
      applyFilters({ repick: false });
    });
    input.addEventListener('change', () => {
      const clamp = key === 'rating' ? clampRating : clampRuntime;
      state.filters[key] = clamp(Number(input.value));
      applyFilters();
    });
  }

  els.decadeChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip[data-decade]');
    if (!chip) return;
    const value = Number(chip.dataset.decade);
    // Decades are single-select: a new choice replaces the previous one.
    if (!value) state.filters.decades.clear();
    else if (state.filters.decades.size === 1 && state.filters.decades.has(value)) {
      state.filters.decades.clear();
    } else {
      state.filters.decades.clear();
      state.filters.decades.add(value);
    }
    applyFilters();
  });

  els.countryChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip[data-country]');
    if (!chip) return;
    const value = chip.dataset.country;
    // Countries are single-select too; only genre keeps multi-select.
    if (!value) state.filters.countries.clear();
    else if (state.filters.countries.size === 1 && state.filters.countries.has(value)) {
      state.filters.countries.clear();
    } else {
      state.filters.countries.clear();
      state.filters.countries.add(value);
    }
    applyFilters();
  });

  els.clearFilters.addEventListener('click', clearAllFilters);
  els.emptyReset.addEventListener('click', clearAllFilters);

  els.activeChips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-remove]');
    if (!chip) return;

    if (chip.dataset.remove === 'genre') state.filters.genres.delete(chip.dataset.value);
    else if (chip.dataset.remove === 'rating') state.filters.rating = 0;
    else if (chip.dataset.remove === 'runtime') state.filters.runtime = 0;
    else if (chip.dataset.remove === 'decade') state.filters.decades.delete(Number(chip.dataset.value));
    else if (chip.dataset.remove === 'country') state.filters.countries.delete(chip.dataset.value);

    applyFilters();
  });

  els.pickBtn.addEventListener('click', () => {
    if (!state.pool.length) computePool();
    pickFilm();
  });

  els.spotlight.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-share-toggle]');
    if (toggle) {
      toggleShareMenu(toggle);
      return;
    }
    const option = event.target.closest('[data-share]');
    if (option) {
      closeShareMenus();
      shareCurrentFilm(option.dataset.share);
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.share-wrap')) closeShareMenus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeShareMenus({ restoreFocus: true });
  });

  // Shortcuts read event.code, not event.key: the code names the physical
  // key, so R and F keep working on an Arabic (or any other) layout where
  // the same key produces a different character.
  const isTypingTarget = (target) => {
    const tag = target?.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable;
  };

  function toggleShortcutsDialog() {
    if (!els.shortcutsDialog) return;
    if (els.shortcutsDialog.open) els.shortcutsDialog.close();
    else els.shortcutsDialog.showModal();
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey) return;

    // Ctrl+/ toggles the shortcuts dialog from anywhere — including inside a
    // field, because the combination never types a character. The bare ?
    // (Shift+/ on most layouts) does the same, but only outside fields.
    if (event.code === 'Slash' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleShortcutsDialog();
      return;
    }
    if (event.code === 'Slash' && event.shiftKey && !isTypingTarget(event.target)) {
      event.preventDefault();
      toggleShortcutsDialog();
      return;
    }

    if (event.metaKey || event.ctrlKey) return;
    if (isTypingTarget(event.target)) return;
    if (state.view !== 'app' || els.shortcutsDialog?.open) return;

    if (event.code === 'KeyR') {
      event.preventDefault();
      pickFilm();
    } else if (event.code === 'KeyF') {
      event.preventDefault();
      toggleDetailsAnimated(els.filterPanel);
    } else if (event.code === 'KeyL') {
      event.preventDefault();
      I18N.setLang(I18N.isArabic() ? 'en' : 'ar');
    } else if (event.code === 'KeyT') {
      event.preventDefault();
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    } else {
      return;
    }
    // R/F are shortcuts, not navigation, so drop whatever the last mouse click
    // left focused. Chrome lights :focus-visible on a mouse-focused element
    // the moment a real key lands — a clicked filter header would suddenly
    // ring green on the next R. (Tab position survives: Chrome resumes from
    // the blurred element.)
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });

  window.addEventListener('hashchange', () => {
    if (state.view === 'loading') return;
    const { username, filters } = readHash();
    if (!username) {
      if (state.view !== 'landing') showLanding();
      return;
    }
    if (username !== state.username) {
      loadUser(username, { filters });
    } else if (state.view === 'app') {
      state.filters = filters;
      applyFilters();
    }
  });
}

function boot() {
  I18N.apply();
  syncLanguageToggle();
  applyTheme(currentTheme(), { persist: false });

  bindEvents();

  // The field stays empty (placeholder visible); previous usernames live in
  // the datalist suggestions only.
  renderUserSuggestions();

  const { username, filters } = readHash();
  if (username) {
    loadUser(username, { filters });
  } else {
    setView('landing');
    // The landing is the common first screen: warm the last-used source now,
    // exactly as showLanding() does on later returns to it.
    schedulePrefetch();
  }
}

boot();
