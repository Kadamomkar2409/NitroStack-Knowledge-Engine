import { readFile } from 'node:fs/promises';
import { AppError, closeDatabase, corpusOrigin, authenticate } from '../backend/core/db.ts';
import { fetchCorpusPage, ingest, refreshStatus } from '../backend/core/ingest.ts';
import { load } from 'cheerio';

const explicit = process.argv.slice(2);
const limit = Number(process.env.CRAWL_LIMIT || 100);
const delay = Number(process.env.CRAWL_DELAY_MS || 22000);
if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(delay) || delay < 700) {
  throw new Error('Use a positive CRAWL_LIMIT and a CRAWL_DELAY_MS of at least 700.');
}
const boot = `${corpusOrigin}/docs/getting-started/overview`;
try {
  const apiKey = (await readFile('.env.tenant-nitrostack', 'utf8')).trim();
  const identity = await authenticate('Bearer ' + apiKey);
  const robots = await fetch(corpusOrigin + '/robots.txt', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (robots.status !== 404 && !robots.ok) throw new Error('Could not check corpus crawler permissions.');
  if (robots.ok && /^\s*disallow:\s*\//im.test(await robots.text())) {
    throw new Error('The corpus publishes crawl restrictions. Review robots.txt before running the crawler.');
  }
  let urls = explicit;
  if (!urls.length) {
    const response = await fetch(corpusOrigin + '/sitemap.xml', { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Could not load the docs sitemap.');
    const $ = load(await response.text(), { xml: true });
    urls = [...new Set([boot, ...$('loc').map((_, node) => $(node).text().trim()).get()
      .filter(url => url.startsWith(corpusOrigin + '/docs/'))])].slice(0, limit);
  }
  let failures = 0;
  for (const url of urls) {
    try {
      const page = await fetchCorpusPage(url);
      let result;
      try { result = await ingest(identity, 'nitrostack-docs', page); }
      catch (error) {
        if (!(error instanceof AppError) || error.status !== 429) throw error;
        console.log('Voyage rate limited the crawl. Retrying after 61 seconds.');
        await new Promise(resolve => setTimeout(resolve, 61000));
        result = await ingest(identity, 'nitrostack-docs', page);
      }
      const status = await refreshStatus(identity, result.documentId);
      console.log(status.status, result.changed ? 'ingested' : 'unchanged', url);
    } catch (error) {
      failures++;
      console.error('Failed:', url, error instanceof Error ? error.message : String(error));
    }
    if (url !== urls.at(-1)) await new Promise(resolve => setTimeout(resolve, delay));
  }
  if (failures) process.exitCode = 1;
} finally {
  await closeDatabase();
}
