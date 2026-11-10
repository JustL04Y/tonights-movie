'use strict';

/* ─────────────────────────────────────────────────────────────
   Tonight's Reel — synopsis translation (English → Arabic)

   Google is the primary translator because it handles a whole
   synopsis in one request. It is tried through two independent
   endpoints, with a retry round and a short circuit-breaker so a
   throttled endpoint cannot stall every following pick:

     1. translate.googleapis.com (gtx)   — POST, no URL length limit
     2. clients5.google.com (dict-chrome-ex)
     3. MyMemory — free tier, chunked, last resort.

   Results are cached on disk so a film is only translated once.
   Returns null (never throws) when every provider is unavailable;
   the client retries with backoff instead of sticking to English.
   ───────────────────────────────────────────────────────────── */

const fsp = require('node:fs/promises');
const path = require('node:path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'translations.json');
const CACHE_VERSION = 1;
const MAX_CHARS = 4000;
const GOOGLE_CHUNK_CHARS = 1800;
const MYMEMORY_CHUNK_CHARS = 450;
const TIMEOUT_MS = 6000;
const GAP_MS = 200;
const MYMEMORY_COOLDOWN_MS = 10 * 60 * 1000;
const GOOGLE_ROUNDS = 2;
const GOOGLE_RETRY_DELAYS = [250, 700];

const cache = new Map();
const inFlight = new Map();
let loaded = false;
let loadPromise = null;
let writeTimer = null;
let myMemoryCooldownUntil = 0;
let googleCooldownUntil = 0;
let googleFailures = 0;

const ARABIC_RE = /[\u0600-\u06FF]/;
const LATIN_RE = /[A-Za-z]/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitChunks(text, maxChars) {
  const words = text.split(' ');
  const chunks = [];
  let current = '';

  for (const word of words) {
    if (current && current.length + 1 + word.length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function looksTranslated(source, output) {
  const value = normalize(output);
  if (!value) return false;
  // Guard against an endpoint echoing the source or returning markup/errors.
  if (value === normalize(source)) return false;
  if (/<\/?[a-z][^>]*>/i.test(value)) return false;
  if (/MYMEMORY WARNING/i.test(value)) return false;
  // A real English→Arabic translation contains Arabic script. Very short
  // strings (a name, "OK") are exempt so they are not rejected unfairly.
  if (source.length >= 24 && LATIN_RE.test(source) && !ARABIC_RE.test(value)) return false;
  return true;
}

async function load() {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fsp.readFile(CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
          for (const [key, value] of Object.entries(parsed.entries)) {
            if (typeof value === 'string' && value) cache.set(key, value);
          }
        }
      } catch {
        // Missing or unreadable cache just means we start empty.
      }
      loaded = true;
    })();
  }
  await loadPromise;
}

function scheduleSave() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    const payload = {
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: Object.fromEntries(cache),
    };
    const body = JSON.stringify(payload, null, 2);
    try {
      await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
      // Write-then-rename keeps the cache readable if the process is killed.
      const temp = `${CACHE_PATH}.tmp`;
      await fsp.writeFile(temp, body, 'utf8');
      await fsp.rename(temp, CACHE_PATH);
    } catch {
      // A failed cache write must not affect the response.
      try {
        await fsp.writeFile(CACHE_PATH, body, 'utf8');
      } catch {
        // Ignore: the translation itself is still delivered.
      }
    }
  }, 800);
}

async function requestJson(url, { body, fresh = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { 'User-Agent': 'tonights-reel/1.0' };
  // A long-lived server can keep a half-closed keep-alive socket; a retry with
  // Connection: close gets a clean connection instead of reusing the dead one.
  if (fresh) headers.Connection = 'close';
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';

  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (process.env.TRANSLATE_DEBUG) {
        console.warn('[translate] status', response.status, url.slice(0, 48));
      }
      return null;
    }
    return await response.json();
  } catch (error) {
    if (process.env.TRANSLATE_DEBUG) {
      console.warn('[translate] error', error?.name, error?.message, url.slice(0, 48));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseGtx(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return data[0]
    .map((segment) => (Array.isArray(segment) ? String(segment[0] || '') : ''))
    .join('');
}

function parseClients5(data) {
  if (typeof data === 'string') return data;
  if (!Array.isArray(data)) return null;
  if (typeof data[0] === 'string') return data.join('');
  if (Array.isArray(data[0])) return parseGtx(data);
  return null;
}

async function requestGoogleGtx(text, fresh) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t';
  const data = await requestJson(url, { body: `q=${encodeURIComponent(text)}`, fresh });
  return parseGtx(data);
}

async function requestGoogleClients5(text, fresh) {
  const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ar';
  const data = await requestJson(url, { body: `q=${encodeURIComponent(text)}`, fresh });
  return parseClients5(data);
}

async function requestGoogleOnce(text, fresh) {
  const gtx = await requestGoogleGtx(text, fresh);
  if (looksTranslated(text, gtx)) return normalize(gtx);

  const clients5 = await requestGoogleClients5(text, fresh);
  if (looksTranslated(text, clients5)) return normalize(clients5);
  return null;
}

async function requestGoogleChunk(text) {
  for (let round = 0; round < GOOGLE_ROUNDS; round += 1) {
    const translated = await requestGoogleOnce(text, round > 0);
    if (translated) return translated;
    if (round < GOOGLE_ROUNDS - 1) {
      await sleep(GOOGLE_RETRY_DELAYS[round] ?? 700);
    }
  }
  return null;
}

async function translateWithGoogle(cleaned) {
  const parts = splitChunks(cleaned, GOOGLE_CHUNK_CHARS);
  const pieces = [];
  for (const part of parts) {
    const piece = await requestGoogleChunk(part);
    if (!piece) return null;
    pieces.push(piece);
  }
  return pieces.join(' ');
}

async function requestMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    text
  )}&langpair=en%7Car`;
  const data = await requestJson(url);
  if (!data || Number(data.responseStatus) !== 200) return null;
  if (data.quotaFinished) return null;
  const translated = data.responseData?.translatedText;
  return looksTranslated(text, translated) ? normalize(translated) : null;
}

async function translateWithMyMemory(cleaned) {
  const parts = splitChunks(cleaned, MYMEMORY_CHUNK_CHARS);
  const pieces = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) await sleep(GAP_MS);
    const piece = await requestMyMemory(parts[index]);
    if (!piece) return null;
    pieces.push(piece);
  }
  return pieces.join(' ');
}

async function translateWithFallback(cleaned) {
  if (Date.now() < myMemoryCooldownUntil) return null;
  const result = await translateWithMyMemory(cleaned);
  if (result) {
    myMemoryCooldownUntil = 0;
    return result;
  }
  myMemoryCooldownUntil = Date.now() + MYMEMORY_COOLDOWN_MS;
  return null;
}

// Providers throttle bursts, so cache misses run one at a time with a small gap.
let queue = Promise.resolve();
let lastRequestAt = 0;

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function runTranslation(cleaned) {
  let result = null;

  if (Date.now() < googleCooldownUntil) {
    result = await translateWithFallback(cleaned);
  } else {
    result = await translateWithGoogle(cleaned);
    if (result) {
      googleFailures = 0;
      googleCooldownUntil = 0;
    } else {
      googleFailures += 1;
      // 5s, 10s, 20s, 40s, capped at 60s.
      const backoff = Math.min(60000, 5000 * 2 ** (googleFailures - 1));
      googleCooldownUntil = Date.now() + backoff;
      result = await translateWithFallback(cleaned);
    }
  }

  if (process.env.TRANSLATE_DEBUG) {
    console.warn(
      '[translate]',
      result ? 'ok' : 'failed',
      cleaned.length,
      'chars',
      result ? '' : `(googleFailures=${googleFailures})`
    );
  }

  if (!result) return null;

  const key = `ar:${cleaned}`;
  cache.set(key, result);
  scheduleSave();
  return result;
}

async function translate(text, lang = 'ar') {
  if (!text || typeof text !== 'string') return null;
  if (lang !== 'ar') return null;

  const cleaned = normalize(text).slice(0, MAX_CHARS);
  if (!cleaned) return null;

  const key = `${lang}:${cleaned}`;
  await load();
  if (cache.has(key)) return cache.get(key);

  // Identical synopses can be requested at the same time (e.g. two picks in
  // quick succession); share one provider call instead of translating twice.
  if (inFlight.has(key)) return inFlight.get(key);

  const task = enqueue(async () => {
    if (cache.has(key)) return cache.get(key);

    const wait = GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    return runTranslation(cleaned);
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, task);
  return task;
}

module.exports = { translate };
