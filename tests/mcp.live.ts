import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDatabase, corpusOrigin, database, digest, env } from '../backend/core/db.ts';
import { refreshStatus } from '../backend/core/ingest.ts';

async function verify() {
  for (const name of ['MONGODB_URI', 'MONGODB_DB', 'VOYAGE_API_KEY', 'OPENROUTER_API_KEY', 'LLM_MODEL']) env(name);
  const { startKnowledgeServer } = await import('../mcp/server.ts');
  const db = database();
  const run = randomBytes(8).toString('hex');
  const a = { tenantId: `mcp-test-${run}-a`, roles: ['admin'], key: randomBytes(32).toString('base64url') };
  const b = { tenantId: `mcp-test-${run}-b`, roles: ['admin'], key: randomBytes(32).toString('base64url') };
  const reader = { tenantId: a.tenantId, roles: ['reader'], key: randomBytes(32).toString('base64url') };
  const tenants = [a, b, reader].map(({ tenantId, roles, key }) => ({ tenantId, roles, apiKeyHash: digest(key), createdAt: new Date() }));
  const tenantFilter = { tenantId: { $in: [a.tenantId, b.tenantId] } };
  const collection = 'verification';
  const port = Number(process.env.MCP_PORT ?? 3001);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const clients: Client[] = [];
  const fetchDirect = globalThis.fetch;
  const voyageOrigin = new URL(process.env.VOYAGE_API_BASE || 'https://ai.mongodb.com/v1').origin;
  let nextVoyage = 0;
  let server: Awaited<ReturnType<typeof startKnowledgeServer>> | undefined;

  // Rate-limit real HTTP calls, including retries and multi-batch ingestion.
  globalThis.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== voyageOrigin) return fetchDirect(input, init);
    const slot = Math.max(nextVoyage, Date.now());
    nextVoyage = slot + 22_000;
    if (slot > Date.now()) await delay(slot - Date.now());
    const response = await fetchDirect(input, { ...init, signal: AbortSignal.timeout(18_000) });
    console.log(`Voyage ${target.pathname} HTTP ${response.status}`);
    return response;
  };

  async function connect(key: string) {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
    const client = new Client({ name: 'knowledge-live-check', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }

  async function call(client: Client, name: string, args: Record<string, unknown>, expectedError?: string) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const data = result.structuredContent as Record<string, unknown> | undefined;
    assert.ok(data, `${name} must return structured content`);
    if (result.isError || expectedError) {
      console.log(name, JSON.stringify(data));
      assert.equal(result.isError, true);
      assert.equal((data.error as { code?: string })?.code, expectedError);
    }
    return data;
  }

  async function indexed(identity: typeof a, id: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await refreshStatus(identity, id)).status === 'indexed') return;
      await delay(2000);
    }
    throw Error('Atlas did not index a verification document within 60 seconds.');
  }

  try {
    await db.collection('tenants').insertMany(tenants);
    server = await startKnowledgeServer(port);
    const { client: owner, transport } = await connect(a.key);
    const { client: other } = await connect(b.key);
    const { client: readonly } = await connect(reader.key);
    const toolNames = (await owner.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(toolNames, ['answer_question', 'delete_document', 'get_source', 'get_usage', 'ingest_document', 'list_collections', 'search_knowledge']);
    console.log('tools/list:', JSON.stringify(toolNames));

    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', clientInfo: { name: 'unauthorized-check', version: '1.0.0' }, capabilities: {},
    } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const [label, credential] of [['missing', ''], ['invalid', `Bearer ${randomBytes(32).toString('base64url')}`]]) {
      const response = await fetchDirect(url, { method: 'POST', body: initialize,
        headers: { ...headers, ...(credential && { Authorization: credential }) } });
      assert.equal(response.status, 401);
      console.log(`${label} API key: HTTP ${response.status}`, JSON.stringify(await response.json()));
    }
    assert.ok(transport.sessionId);
    const wrongSession = await fetchDirect(url, { method: 'POST', body: '{"jsonrpc":"2.0","method":"tools/list","id":2}',
      headers: { ...headers, Authorization: `Bearer ${b.key}`, 'Mcp-Session-Id': transport.sessionId } });
    assert.equal(wrongSession.status, 404);
    console.log('Foreign session: HTTP 404', JSON.stringify(await wrongSession.json()));

    const sourceUrl = `${corpusOrigin}/docs/getting-started/overview`;
    const publicDoc = await call(owner, 'ingest_document', { collection, url: sourceUrl });
    const privateDoc = await call(other, 'ingest_document', { collection,
      file: { name: 'README.md', base64: (await readFile(new URL('../README.md', import.meta.url))).toString('base64') } });
    assert.equal(publicDoc.changed, true);
    assert.equal(privateDoc.changed, true);
    console.log('ingest_document:', JSON.stringify({ primary: publicDoc, secondTenant: privateDoc }));
    await indexed(a, String(publicDoc.documentId));
    await indexed(b, String(privateDoc.documentId));

    const listed = await call(owner, 'list_collections', {});
    assert.equal((listed.collections as { documents: number }[])[0]?.documents, 1);
    console.log('list_collections:', JSON.stringify(listed));
    await call(owner, 'search_knowledge', { query: 'test', filters: { tenantId: b.tenantId } }, 'invalid_input');
    await call(readonly, 'delete_document', { documentId: publicDoc.documentId }, 'forbidden');
    await call(owner, 'get_source', { documentId: privateDoc.documentId }, 'source_not_found');
    await call(owner, 'delete_document', { documentId: privateDoc.documentId }, 'document_not_found');

    // Target a term specific to the other tenant's real README, then confirm it is visible to its owner only.
    const query = { query: 'CRAWL_DELAY_MS', collection, mode: 'hybrid', rerank: false, topK: 3 };
    const ownerSearch = await call(owner, 'search_knowledge', query);
    const otherSearch = await call(other, 'search_knowledge', query);
    const safeRows = ownerSearch.results as { documentId: string; score: number; source: unknown }[];
    assert.ok(safeRows.length > 0 && safeRows.every(row => row.documentId === publicDoc.documentId));
    assert.ok((otherSearch.results as { documentId: string; text: string }[])
      .some(row => row.documentId === privateDoc.documentId && row.text.includes('CRAWL_DELAY_MS')));
    console.log('search_knowledge:', JSON.stringify(safeRows.map(({ documentId, score, source }) => ({ documentId, score, source }))));

    const grounded = await call(owner, 'answer_question', {
      query: 'What is NitroStack and what does it help developers build?', collection, rerank: false,
    });
    const citations = grounded.citations as { documentId: string; source: unknown }[];
    assert.ok(typeof grounded.answer === 'string' && citations.length && citations.every(row => row.documentId === publicDoc.documentId));
    console.log('answer_question:', JSON.stringify({ answer: grounded.answer, citations: citations.map(row => row.source), usage: grounded.usage }));

    const source = await call(owner, 'get_source', { documentId: publicDoc.documentId });
    assert.equal(source.documentId, publicDoc.documentId);
    console.log('get_source:', JSON.stringify({ documentId: source.documentId, source: source.source, chunkCount: source.chunkCount }));

    const usage = await call(owner, 'get_usage', { period: 7 });
    const providers = (usage.usage as { provider: string; tokens: number }[]).filter(row => row.tokens > 0).map(row => row.provider);
    assert.ok(providers.includes('voyage') && providers.includes('openrouter'));
    console.log('get_usage:', JSON.stringify(usage));

    const deleted = await call(owner, 'delete_document', { documentId: publicDoc.documentId });
    assert.equal(deleted.deleted, true);
    console.log('delete_document:', JSON.stringify(deleted));
    await call(owner, 'get_source', { documentId: publicDoc.documentId }, 'source_not_found');
  } finally {
    globalThis.fetch = fetchDirect;
    await Promise.allSettled(clients.map(client => client.close()));
    try {
      await Promise.all(['chunks', 'documents', 'usage', 'tenants'].map(name => db.collection(name).deleteMany(tenantFilter)));
    } finally {
      await server?.stop();
      await closeDatabase();
    }
  }
}

try {
  await verify();
} catch (failure) {
  const error = failure instanceof Error ? failure : Error('Unknown verification failure.');
  console.error(`${error.name}: ${error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, '[REDACTED MONGODB URI]')}`);
  process.exitCode = 1;
}

// NitroStack's rate-limit package keeps a process-wide timer alive after shutdown.
await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>(resolve => stream.write('', () => resolve()))));
process.exit(process.exitCode ?? 0);
