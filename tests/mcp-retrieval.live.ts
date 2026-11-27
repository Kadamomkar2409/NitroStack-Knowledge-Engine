import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { authenticateKeyHash, closeDatabase, corpusOrigin, embeddingModel } from '../backend/core/db.ts';
import { chunks, documents, tenantFilter } from '../backend/core/ingest.ts';
import { loadMcpConfiguration } from '../mcp/config.ts';
import { readWorkspaceCredentialHash } from '../mcp/windows-credential.ts';

const queries = [
  { label: 'exact', query: 'createServer', path: '/docs/getting-started/core-concepts/bootstrap' },
  { label: 'semantic', query: 'How does NitroStack help developers build MCP applications?', path: '/docs/getting-started/overview' },
] as const;
const configurations = [
  { mode: 'vector', scoreType: 'cosine' },
  { mode: 'hybrid', scoreType: 'rrf' },
  { mode: 'hybrid', scoreType: 'rerank', rerankModel: 'rerank-3-lite' },
  { mode: 'hybrid', scoreType: 'rerank', rerankModel: 'rerank-3' },
] as const;
type ProviderCall = { voyage: 'embed' | 'rerank'; status: number; gapMs: number | null;
  candidateCount?: number; topK?: number; scores?: number[]; elapsedMs: number };
type SearchResult = { results: { chunkId: string; documentId: string; score: number; source: { url: string } }[];
  usage: { provider: string; model: string; tokens: number; cost: number }[]; latencyMs: number; scoreType: string };

const collection = 'nitrostack-docs';
const client = new Client({ name: 'knowledge-milestone-3', version: '1.0.0' });
const events: ProviderCall[] = [];
let failures = 0;
let phase = 'workspace authentication';

async function verify() {
  loadMcpConfiguration({ loadTenantKey: false });
  const identity = await authenticateKeyHash(await readWorkspaceCredentialHash());
  phase = 'indexed corpus preflight';
  const filter = tenantFilter(identity);
  const indexed = await documents().find({ ...filter, collectionId: collection, status: 'indexed', embeddingModel: embeddingModel() }).toArray();
  const byId = new Map(indexed.map(row => [row._id, row]));
  assert.ok(queries.every(({ path }) => indexed.some(row => row.source.url === corpusOrigin + path)), 'Expected indexed docs');
  const sparse = indexed.reduce((shortest, row) => row.chunkCount < shortest.chunkCount ? row : shortest);
  const available = await chunks().countDocuments({ ...filter, documentId: sparse._id, version: sparse.version });
  assert.ok(available > 0 && available < 20, 'Expected a real document with fewer than 20 eligible chunks');

  phase = 'STDIO initialization';
  const transport = new StdioClientTransport({ command: process.execPath, stderr: 'pipe', args: [
    '--import', new URL('./pace-voyage.live.ts', import.meta.url).href,
    fileURLToPath(new URL('../dist/mcp/stdio.js', import.meta.url)),
  ], env: { ...process.env } as Record<string, string> });
  const stderr = transport.stderr;
  assert.ok(stderr instanceof Readable);
  createInterface({ input: stderr }).on('line', line => {
    try {
      const event = JSON.parse(line) as ProviderCall;
      if (event.voyage === 'embed' || event.voyage === 'rerank') events.push(event);
    } catch { /* Never print raw child diagnostics. */ }
  });
  await client.connect(transport);
  phase = 'live queries';

  async function run(label: string, query: string, config: typeof configurations[number], expected: string,
    candidates: number, topK: number, version?: string, availableCandidates = candidates) {
    const before = events.length;
    const rerankModel = 'rerankModel' in config ? config.rerankModel : undefined;
    try {
      const result = await client.callTool({ name: 'search_knowledge', arguments: { query, collection, topK,
        mode: config.mode, rerank: !!rerankModel, rerankModel, candidates, filters: version ? { version } : undefined,
      } }, undefined, { timeout: 180_000 });
      const data = result.structuredContent as SearchResult | undefined;
      assert.ok(!result.isError && data, `tool returned ${(data as { error?: { code?: string } } | undefined)?.error?.code ?? 'an error'}`);
      const calls = events.slice(before);
      const successful = calls.filter(call => call.status === 200);
      const scores = data.results.map(row => row.score);
      const rank = data.results.findIndex(row => row.source.url === expected) + 1;
      console.log(JSON.stringify({ label, mode: rerankModel ?? config.scoreType, rank, scores,
        latencyMs: data.latencyMs, providerMs: calls.reduce((sum, call) => sum + call.elapsedMs, 0),
        tokens: data.usage.map(row => row.tokens), cost: data.usage.map(row => row.cost),
        candidateCount: successful[1]?.candidateCount, providerStatuses: calls.map(call => call.status) }));
      assert.ok(rank > 0 && rank <= 5, 'expected source ranked in the top five');
      assert.equal(data.scoreType, config.scoreType);
      const scoreMax = config.scoreType === 'rrf' ? 2 / 61 : 1;
      assert.ok(scores.every((score, i) => Number.isFinite(score) && score >= 0 && score <= scoreMax &&
        (i === 0 || scores[i - 1] >= score)), 'scores are in range and descending');
      assert.ok(data.results.length <= topK && new Set(data.results.map(row => row.chunkId)).size === data.results.length);
      assert.ok(data.results.every(row => {
        const doc = byId.get(row.documentId);
        return doc && doc.source.url === row.source.url && (!version || doc.version === version);
      }), 'all results map to authorized active documents');
      assert.deepEqual(successful.map(call => call.voyage), rerankModel ? ['embed', 'rerank'] : ['embed']);
      assert.deepEqual(data.usage.map(row => row.model), rerankModel ? [embeddingModel(), rerankModel] : [embeddingModel()]);
      assert.ok(data.usage.every(row => row.provider === 'voyage' && row.tokens > 0 && row.cost > 0));
      if (rerankModel) {
        assert.equal(successful[1].candidateCount, availableCandidates);
        assert.equal(successful[1].topK, Math.min(topK, availableCandidates));
        assert.deepEqual(scores, successful[1].scores);
      }
    } catch (error) {
      failures++;
      // Assertions below deliberately use public labels or numbers only.
      console.error(`${label}/${rerankModel ?? config.scoreType} failed: ${error instanceof assert.AssertionError ? error.message : 'live MCP request failed'}`);
    }
  }

  for (const { label, query, path } of queries) {
    for (const config of configurations) await run(label, query, config, corpusOrigin + path, 12, 5);
  }
  assert.ok(sparse.source.url);
  await run('sparse', sparse.source.title, configurations[2], sparse.source.url, 24, 20, sparse.version, available);
  assert.ok(events.slice(1).every(call => call.gapMs !== null && call.gapMs >= 22_000), 'All Voyage dispatches are spaced at least 22 seconds apart');
  console.log(`Voyage dispatches: ${events.length}; minimum gap: ${Math.min(...events.slice(1).map(call => call.gapMs!))} ms; failed cases: ${failures}`);
}

try { await verify(); }
catch (error) {
  console.error(`Live retrieval verification could not complete during ${phase}${error instanceof assert.AssertionError ? ` (${error.message})` : ''}.`);
  failures++;
}
finally { await client.close(); await closeDatabase(); }
process.exitCode = failures ? 1 : 0;
