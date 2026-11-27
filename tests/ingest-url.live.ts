import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCorpusPage } from '../backend/core/ingest.ts';
import { corpusOrigin } from '../backend/core/db.ts';

const overview = `${corpusOrigin}/docs/getting-started/overview`;

test('docs root alias fetches and parses the canonical Overview page', async () => {
  const result = await fetchCorpusPage(`${corpusOrigin}/docs/`);
  assert.equal(result.source.url, overview);
  assert.equal(result.type, 'html');
  assert.ok(result.pages[0].text.trim());
});

test('a redirecting docs URL is rejected without following the redirect', async () => {
  await assert.rejects(fetchCorpusPage(`${overview}/`), { code: 'source_redirect', status: 422 });
});

test('URLs outside the allowlist are rejected', async () => {
  await assert.rejects(fetchCorpusPage(`${corpusOrigin}/docs`), { code: 'invalid_url', status: 400 });
  await assert.rejects(fetchCorpusPage('https://www.mongodb.com/docs/'), { code: 'invalid_url', status: 400 });
});
