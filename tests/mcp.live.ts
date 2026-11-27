import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import api from '../backend/api/dispatch.ts';
import { GET as nextGet } from '../app/api/[...route]/route.ts';
import { authenticate, closeDatabase, corpusOrigin, database, digest, env, lexicalIndex, vectorIndex } from '../backend/core/db.ts';
import type { Identity } from '../backend/core/db.ts';
import { chunks, documents, fetchCorpusPage, refreshStatus } from '../backend/core/ingest.ts';
import { indexFilters } from '../backend/core/retrieval.ts';
import { loadMcpConfiguration } from '../mcp/config.ts';
import { readWorkspaceCredentialHash } from '../mcp/windows-credential.ts';
import { updateTestVault } from './security-vault.ts';

const run = randomBytes(12).toString('hex');
const collection = `security-${run}`;
const target = (role: string) => `KnowledgeEngine-MCP-STDIO-Test-${run}-${role}`;
const newKey = () => randomBytes(32).toString('base64url');
const a = { tenantId: `${collection}-a`, role: 'a', roles: ['admin'], key: newKey() };
const b = { tenantId: `${collection}-b`, role: 'b', roles: ['admin'], key: newKey() };
const reader = { tenantId: a.tenantId, role: 'reader', roles: ['reader'], key: newKey() };
const principals = [a, b, reader];
const hashes = principals.map(p => ({ tenantId: p.tenantId, roles: p.roles, apiKeyHash: digest(p.key), createdAt: new Date() }));
const workspaceFilter = { tenantId: { $in: [a.tenantId, b.tenantId] } };
const clients: Client[] = [];
const vaultTargets: string[] = [];
const stdioEntry = fileURLToPath(new URL('../dist/mcp/stdio.js', import.meta.url));
const sortedTools = ['answer_question', 'delete_document', 'get_source', 'get_usage', 'ingest_document', 'list_collections', 'search_knowledge'];
let phase = 'configuration';
let nextVoyage = 0;
let server: Awaited<ReturnType<typeof import('../mcp/server.ts').startKnowledgeServer>> | undefined;

async function paced<T>(operation: () => Promise<T>) {
  await delay(Math.max(0, Math.ceil(nextVoyage - performance.now())));
  try { return await operation(); }
  finally { nextVoyage = performance.now() + 22_001; }
}

// Only safe shape assertions and labels are printed. Provider responses stay in memory.
type Reply = { status: number; data: Record<string, unknown> };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Reply>;
function fromMcp(client: Client): Call {
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const data = result.structuredContent as Reply['data'] | undefined;
    assert.ok(data, 'structured MCP response');
    return { data, status: result.isError ? (data.error as { status: number })?.status : 200 };
  };
}
function fromRest(key: string): Call {
  return async (name, args = {}) => {
    const operations: Record<string, [string, string]> = {
      search_knowledge: ['POST', 'search'], answer_question: ['POST', 'answer'], ingest_document: ['POST', 'ingest'],
      get_source: ['GET', `sources/${args.documentId ?? args.chunkId}`], list_collections: ['GET', 'collections'],
      delete_document: ['DELETE', `documents/${args.documentId}`],
    };
    const [method, path] = operations[name];
    const response = await api.fetch(new Request(`http://localhost/api/${path}`, { method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(args) : undefined }));
    return { status: response.status, data: await response.json() as Reply['data'] };
  };
}
async function connect(transport: StdioClientTransport | StreamableHTTPClientTransport) {
  const client = new Client({ name: 'knowledge-security-live', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), sortedTools);
  return fromMcp(client);
}
function expect(reply: Reply, status: number, code?: string) {
  assert.equal(reply.status, status, 'expected authorization or success status');
  if (code) assert.equal((reply.data.error as { code?: string })?.code, code);
  return reply.data;
}

async function verify() {
  loadMcpConfiguration({ loadTenantKey: false });
  for (const key of ['MONGODB_URI', 'MONGODB_DB', 'VOYAGE_API_KEY', 'OPENROUTER_API_KEY', 'LLM_MODEL']) env(key);
  const baselineVaultHash = await readWorkspaceCredentialHash();
  const urls = {
    a: `${corpusOrigin}/docs/getting-started/overview`,
    b: `${corpusOrigin}/docs/getting-started/core-concepts/bootstrap`,
    private: `${corpusOrigin}/docs/studio/authentication`,
  };
  await Promise.all(Object.values(urls).map(fetchCorpusPage));
  const db = database();
  await db.command({ ping: 1 });
  const registry = db.collection('tenants');
  assert.equal(await registry.countDocuments(workspaceFilter), 0, 'test workspace IDs must be unused');
  assert.equal(await documents().countDocuments(workspaceFilter), 0, 'test document namespaces must be unused');
  assert.equal(await chunks().countDocuments(workspaceFilter), 0, 'test chunk namespaces must be unused');
  assert.equal(await db.collection('usage').countDocuments(workspaceFilter), 0, 'test usage namespaces must be unused');
  const productionBefore = await registry.countDocuments({ tenantId: { $nin: [a.tenantId, b.tenantId] } });

  phase = 'isolated provisioning';
  for (const p of [...principals, { role: 'invalid', key: newKey() }]) {
    await updateTestVault(target(p.role), p.key);
    vaultTargets.push(target(p.role));
    assert.equal(await readWorkspaceCredentialHash(target(p.role)), digest(p.key));
  }
  await registry.insertMany(hashes);
  const identities = new Map<string, Identity>();
  for (const p of principals) {
    const identity = await authenticate(`Bearer ${p.key}`);
    assert.equal(identity.tenantId, p.tenantId);
    assert.deepEqual(identity.roles, p.roles);
    identities.set(p.role, identity);
  }
  console.log('Provisioned two isolated test workspaces and three hashed principals.');

  phase = 'transport authentication';
  await import('./pace-voyage.live.ts');
  const { startKnowledgeServer } = await import('../mcp/server.ts');
  const port = Number(process.env.MCP_SECURITY_PORT || 3104);
  server = await startKnowledgeServer(port, { shutdownHooks: false });
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const http = (key: string) => new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { authorization: `Bearer ${key}` } } });
  const stdio = (role: string) => new StdioClientTransport({ command: process.execPath, stderr: 'ignore', env: { ...process.env } as Record<string, string>,
    args: ['--import', new URL('./pace-voyage.live.ts', import.meta.url).href, stdioEntry, '--credential-target', target(role)] });
  const httpOwnerTransport = http(a.key);
  const [httpA, httpB, httpReader, stdioA, stdioB, stdioReader] = await Promise.all([
    connect(httpOwnerTransport), connect(http(b.key)), connect(http(reader.key)), connect(stdio('a')), connect(stdio('b')), connect(stdio('reader')),
  ]);
  const restA = fromRest(a.key), restB = fromRest(b.key), restReader = fromRest(reader.key);
  for (const key of [undefined, newKey()]) {
    const authorization = key ? { authorization: `Bearer ${key}` } : undefined;
    const response = await fetch(endpoint, { method: 'POST', headers: { ...authorization, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    const rest = await api.fetch(new Request('http://localhost/api/collections', { headers: authorization }));
    assert.equal(rest.status, 401);
  }
  assert.ok(httpOwnerTransport.sessionId);
  for (const key of [b.key, reader.key]) {
    const response: Response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`,
      'mcp-session-id': httpOwnerTransport.sessionId, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(response.status, 404);
  }
  for (const role of ['missing', 'invalid']) {
    const child = spawn(process.execPath, [stdioEntry, '--credential-target', target(role)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 20_000);
    let protocolBytes = 0;
    let diagnostic = '';
    child.stdout.on('data', bytes => { protocolBytes += bytes.length; });
    child.stderr.setEncoding('utf8').on('data', text => { diagnostic = (diagnostic + text).slice(-2048); });
    try {
      assert.deepEqual(await once(child, 'close'), [1, null]);
      assert.equal(protocolBytes, 0);
      assert.ok(role === 'missing' ? diagnostic.includes('Generic Credential') : diagnostic.includes('valid workspace API key'));
    } finally { clearTimeout(timeout); }
  }
  const next = await nextGet(new Request('http://localhost/api/collections', { headers: { authorization: `Bearer ${a.key}` } }),
    { params: Promise.resolve({ route: ['collections'] }) });
  assert.equal(next.status, 200);
  console.log('HTTP/STDIO authenticated all roles; REST and Next entry points authenticated; missing, invalid, and borrowed HTTP sessions denied.');

  phase = 'real document ingestion and reader RBAC';
  const fixtures = [
    { owner: a, call: httpA, url: urls.a, visibility: ['tenant'], status: 200 },
    { owner: b, call: stdioB, url: urls.b, visibility: ['tenant'], status: 200 },
    { owner: a, call: restA, url: urls.private, visibility: ['admin'], status: 202 },
  ];
  const fixtureIds = fixtures.map(f => digest(JSON.stringify([f.owner.tenantId, collection, f.url])));
  const ownedFilter = { ...workspaceFilter, collectionId: collection };
  async function cleanupAtlas() {
    await chunks().deleteMany({ ...ownedFilter, documentId: { $in: fixtureIds } });
    await documents().deleteMany({ ...ownedFilter, _id: { $in: fixtureIds } });
    await db.collection('usage').deleteMany(workspaceFilter);
    await registry.deleteMany({ ...workspaceFilter, apiKeyHash: { $in: hashes.map(p => p.apiKeyHash) } });
    assert.equal(await documents().countDocuments(ownedFilter), 0);
    assert.equal(await chunks().countDocuments(ownedFilter), 0);
    assert.equal(await db.collection('usage').countDocuments(workspaceFilter), 0);
    assert.equal(await registry.countDocuments(workspaceFilter), 0);
    assert.equal(await registry.countDocuments({ tenantId: { $nin: [a.tenantId, b.tenantId] } }), productionBefore);
  }
  for (const denied of [httpReader, stdioReader, restReader]) {
    expect(await denied('ingest_document', { collection, url: urls.a }), 403, 'forbidden');
    expect(await denied('delete_document', { documentId: fixtureIds[0] }), 403, 'forbidden');
  }
  for (const [i, fixture] of fixtures.entries()) {
    const reply = await paced(() => fixture.call('ingest_document', { collection, url: fixture.url, visibility: fixture.visibility }));
    assert.equal(expect(reply, fixture.status).documentId, fixtureIds[i]);
    console.log(`Real fixture ${i + 1} ingested by its workspace admin.`);
  }
  for (const [i, fixture] of fixtures.entries()) {
    for (let attempt = 0; ; attempt++) {
      if ((await refreshStatus(identities.get(fixture.owner.role)!, fixtureIds[i])).status === 'indexed') break;
      assert.ok(attempt < 45, 'Atlas fixture reaches both indexes');
      await delay(2000);
    }
  }

  phase = 'Atlas predicates and cross-tenant sources and statistics';
  const [publicA, publicB, privateA] = await Promise.all(fixtureIds.map(_id => documents().findOne({ ...ownedFilter, _id })));
  assert.ok(publicA && publicB && privateA);
  for (const [doc, allowed, denied, term] of [[publicB, 'b', 'a', 'createServer'], [privateA, 'a', 'reader', 'authentication']] as const) {
    const sample = await chunks().findOne({ ...ownedFilter, documentId: doc._id, version: doc.version });
    assert.ok(sample);
    for (const role of [allowed, denied]) {
      const filters = indexFilters(identities.get(role)!, { collection, version: doc.version, sourceType: 'html' });
      const vector = await chunks().aggregate([{ $vectorSearch: { index: vectorIndex, path: 'embedding', queryVector: sample.embedding,
        filter: filters.vector, exact: true, limit: 5 } }, { $project: { documentId: 1 } }]).toArray();
      const text = await chunks().aggregate([{ $search: { index: lexicalIndex, compound: { filter: filters.lexical,
        must: [{ text: { query: term, path: ['text', 'title'] } }] } } }, { $limit: 5 }, { $project: { documentId: 1 } }]).toArray();
      for (const rows of [vector, text]) assert.ok(role === allowed ? rows.length > 0 && rows.every(x => x.documentId === doc._id) : rows.length === 0);
    }
  }
  const foreignChunk = await chunks().findOne({ ...ownedFilter, documentId: publicB._id, version: publicB.version });
  assert.ok(foreignChunk);
  const transports = [[httpA, httpB, httpReader], [stdioA, stdioB, stdioReader], [restA, restB, restReader]] as const;
  for (const [owner, foreign, readOnly] of transports) {
    const A = expect(await owner('list_collections'), 200).collections as object[];
    const B = expect(await foreign('list_collections'), 200).collections as object[];
    const R = expect(await readOnly('list_collections'), 200).collections as object[];
    assert.deepEqual(A, [{ name: collection, documents: 2, chunks: publicA.chunkCount + privateA.chunkCount, indexed: 2 }]);
    assert.deepEqual(B, [{ name: collection, documents: 1, chunks: publicB.chunkCount, indexed: 1 }]);
    assert.deepEqual(R, [{ name: collection, documents: 1, chunks: publicA.chunkCount, indexed: 1 }]);
    assert.equal(expect(await foreign('get_source', { chunkId: foreignChunk._id }), 200).documentId, publicB._id);
    assert.equal(expect(await readOnly('get_source', { documentId: publicA._id }), 200).documentId, publicA._id);
    expect(await owner('get_source', { documentId: publicB._id }), 404, 'source_not_found');
    expect(await owner('get_source', { chunkId: foreignChunk._id }), 404, 'source_not_found');
    expect(await foreign('get_source', { documentId: publicA._id }), 404, 'source_not_found');
    expect(await readOnly('get_source', { documentId: privateA._id }), 404, 'source_not_found');
    expect(await owner('delete_document', { documentId: publicB._id }), 404, 'document_not_found');
  }
  console.log('Both Atlas indexes enforced tenant and visibility prefilters; all three interfaces returned exact authorized counts and denied foreign sources and deletes.');

  phase = 'cross-tenant search and answers';
  const question = 'What does the createServer function do when it bootstraps a NitroStack server?';
  const assertOwnership = (data: Reply['data'], ids: string[]) => {
    for (const key of ['results', 'citations']) {
      for (const row of (data[key] ?? []) as { documentId: string; source: { url: string } }[]) {
        const doc = [publicA, publicB, privateA].find(d => d!._id === row.documentId);
        assert.ok(ids.includes(row.documentId) && doc?.source.url === row.source.url, 'only authorized source IDs and URLs');
      }
    }
  };
  for (const [owner, foreign, readOnly] of transports) {
    const foreignQuery = { collection, query: 'createServer', filters: { version: publicB.version } };
    const own = expect(await paced(() => foreign('search_knowledge', foreignQuery)), 200);
    assert.ok((own.results as unknown[]).length > 0, 'foreign positive search control');
    assertOwnership(own, [publicB._id]);
    const denied = expect(await paced(() => owner('answer_question', { ...foreignQuery, query: question })), 200);
    assert.deepEqual(denied.results, []);
    assert.deepEqual(denied.citations, []);
    assert.equal(denied.answer, null);
    const privateSearch = expect(await paced(() => readOnly('search_knowledge', { collection, query: 'authentication', filters: { version: privateA.version } })), 200);
    assert.deepEqual(privateSearch.results, []);
    console.log('Interface passed positive search, foreign answer denial, and reader search denial.');
  }
  const broad = expect(await paced(() => httpA('search_knowledge', { collection, query: 'createServer' })), 200);
  assertOwnership(broad, [publicA._id, privateA._id]);
  const answer = expect(await paced(() => stdioB('answer_question', { collection, query: question, filters: { version: publicB.version } })), 200);
  assert.ok(typeof answer.answer === 'string' && (answer.citations as unknown[]).length > 0, 'real OpenRouter cited answer for authorized workspace');
  assertOwnership(answer, [publicB._id]);
  console.log('Real OpenRouter answer cited only the owning workspace; no foreign search results, sources, citations or counts were observed.');

  phase = 'authorized deletion and cleanup';
  for (const [owner, id] of [[httpA, publicA._id], [stdioB, publicB._id], [restA, privateA._id]] as const) {
    assert.equal(expect(await owner('delete_document', { documentId: id }), 200).deleted, true);
    expect(await owner('get_source', { documentId: id }), 404, 'source_not_found');
  }
  await cleanupAtlas();
  assert.equal(await readWorkspaceCredentialHash(), baselineVaultHash);
  console.log('Authorized deletes passed; all run-owned Atlas records were removed. Existing workspace count and default vault credential were unchanged.');
}

try { await verify(); }
catch (error) {
  const assertion = error instanceof assert.AssertionError ? ` (${error.message.split('\n')[0]})` : '';
  const category = error && typeof error === 'object' && 'code' in error && error.code === 13 ? ', Atlas denied access' : '';
  console.error(`Milestone 4 stopped during ${phase}${assertion}${category}. Run identifier: ${run}.`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  for (const targetName of vaultTargets) {
    try { await updateTestVault(targetName); }
    catch { console.error('A run-owned vault entry could not be removed.'); process.exitCode = 1; }
  }
  await server?.stop();
  await closeDatabase();
}

await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>(resolve => stream.write('', () => resolve()))));
process.exit(process.exitCode ?? 0);
