'use strict';

/**
 * Builds data/demo.json from a public Letterboxd watchlist.
 * Usage: npm run build:demo -- [username] [pages]
 * Defaults: dave, 3 pages (~84 films).
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadWatchlist, computeStats } = require('../lib/letterboxd');

async function main() {
  const username = process.argv[2] || 'dave';
  const maxPages = Number(process.argv[3] || 3);

  console.log(`Scraping ${username}'s watchlist (up to ${maxPages} pages)…`);

  const payload = await loadWatchlist(username, {
    maxPages,
    concurrency: 16,
    pageConcurrency: 5,
    requestDelayMs: 0,
    pageDelayMs: 100,
    onProgress: (progress) => {
      if (progress.phase === 'watchlist') {
        console.log(
          `  watchlist page ${progress.page}/${progress.pagesTotal}: ${progress.filmsFound} films so far`
        );
      } else if (
        progress.phase === 'details' &&
        (progress.completed % 25 === 0 || progress.completed === progress.total)
      ) {
        console.log(`  details ${progress.completed}/${progress.total} (${progress.failed} failed)`);
      }
    },
  });

  const output = {
    ...payload,
    username: 'demo',
    demo: true,
    demoFrom: username,
    fetchedAt: new Date().toISOString(),
    stats: computeStats(payload.films),
  };

  const target = path.join(__dirname, '..', 'data', 'demo.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nWrote ${output.films.length} films to ${target}`);
  console.log(
    `Genres: ${output.stats.genres.length}, countries: ${output.stats.countries.length}, avg rating: ${output.stats.averageRating}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
