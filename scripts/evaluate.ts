import { readFile } from 'node:fs/promises';
import { AppError, authenticate, closeDatabase, database, embeddingModel } from '../backend/core/db.ts';
import { documents, tenantFilter } from '../backend/core/ingest.ts';
import { search, searchInput } from '../backend/core/retrieval.ts';

type Question = { query: string; expectedUrls: string[] };
const dataset = process.argv[2];
const tenant = process.argv[3] || 'nitrostack';
const collection = process.argv[4] || 'nitrostack-docs';
const delay = Number(process.env.EVAL_DELAY_MS || 22000);
if (!dataset || !/^[a-z0-9-]{2,60}$/.test(tenant) || !Number.isFinite(delay) || delay < 0) {
  throw new Error('Usage: npm run evaluate -- <questions.json> [tenant] [collection]');
}
const configs = [
  { label: 'Vector', mode: 'vector', rerank: false },
  { label: 'Hybrid', mode: 'hybrid', rerank: false },
  { label: 'Hybrid + rerank-3-lite', mode: 'hybrid', rerank: true, rerankModel: 'rerank-3-lite' },
  { label: 'Hybrid + rerank-3', mode: 'hybrid', rerank: true, rerankModel: 'rerank-3' },
];
const selected = process.env.EVAL_CONFIG ? configs.filter(config => config.label === process.env.EVAL_CONFIG) : configs;
if (!selected.length) throw new Error('EVAL_CONFIG does not match a supported configuration.');
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

try {
  const questions: Question[] = JSON.parse(await readFile(dataset, 'utf8'));
  if (!Array.isArray(questions) || !questions.length || questions.some(row =>
    !row || typeof row.query !== 'string' || !row.query.trim() || !Array.isArray(row.expectedUrls) ||
    !row.expectedUrls.length || row.expectedUrls.some(url => typeof url !== 'string'))) {
    throw new Error('Each evaluation question needs a query and one or more expected source URLs.');
  }
  const key = (await readFile(`.env.tenant-${tenant}`, 'utf8')).trim();
  const identity = await authenticate('Bearer ' + key);
  const labeled = [...new Set(questions.flatMap(question => question.expectedUrls))];
  const sourceDocs = await documents().find({ ...tenantFilter(identity), collectionId: collection,
    embeddingModel: embeddingModel(), status: 'indexed', 'source.url': { $in: labeled } }).toArray();
  const available = new Set(sourceDocs.map(doc => doc.source.url));
  if (labeled.some(url => !available.has(url))) throw new Error('All expected source URLs must be indexed in the selected collection.');

  for (const options of selected) {
    const rows = [];
    for (const question of questions) {
      let response: Awaited<ReturnType<typeof search>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await search(identity, searchInput({ ...options, query: question.query, collection, topK: 10 }));
          break;
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 429 || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 61_000));
        }
      }
      if (!response) throw new Error('Retrieval returned no response.');
      const expected = new Set(question.expectedUrls);
      const ranking = response.results.map(result => result.source.url);
      const seen = new Set<string>();
      let dcg = 0;
      ranking.forEach((url, index) => {
        if (url && expected.has(url) && !seen.has(url)) {
          dcg += 1 / Math.log2(index + 2);
          seen.add(url);
        }
      });
      const ideal = Array.from({ length: Math.min(10, expected.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((sum, score) => sum + score, 0);
      rows.push({ recall: seen.size / expected.size, ndcg: dcg / ideal, latency: response.latencyMs,
        cost: response.usage.some(entry => entry.cost === null) ? null : response.usage.reduce((sum, entry) => sum + entry.cost!, 0) });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    const latencies = rows.map(row => row.latency).sort((a, b) => a - b);
    const metrics = { queries: rows.length, recallAt10: average(rows.map(row => row.recall)), ndcgAt10: average(rows.map(row => row.ndcg)),
      p50Ms: latencies[Math.ceil(latencies.length * .5) - 1], p95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
      costPerQuery: rows.some(row => row.cost === null) ? null : average(rows.map(row => row.cost!)) };
    const config = { ...options, embeddingModel: embeddingModel(), collection };
    await database().collection('eval_runs').insertOne({ tenantId: identity.tenantId, timestamp: new Date(), config, metrics });
    console.log(JSON.stringify({ config, metrics }));
  }
} finally { await closeDatabase(); }
