import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpConfiguration } from '../mcp/config.ts';

const tools = ['answer_question', 'delete_document', 'get_source', 'get_usage', 'ingest_document', 'list_collections', 'search_knowledge'];
const clientInfo = { name: 'knowledge-auth-check', version: '1.0.0' };
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', clientInfo, capabilities: {},
} });

async function verify() {
  loadMcpConfiguration();
  const key = process.env.NITROSTACK_TENANT_API_KEY;
  assert.ok(key, 'NITROSTACK_TENANT_API_KEY is missing.');
  const invalidKey = randomBytes(32).toString('base64url');
  const port = Number(process.argv[2] ?? 3000);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Choose a valid local HTTP port.');
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  async function expectUnauthorized(label: string, credentials: string[], sessionId?: string) {
    const body = sessionId ? JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) : initialize;
    const result = await new Promise<{ status?: number; challenge?: string }>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: [
        'Host', url.host, 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)),
        'Accept', 'application/json, text/event-stream', ...credentials, ...(sessionId ? ['Mcp-Session-Id', sessionId] : []),
      ] }, response => {
        response.resume();
        resolve({ status: response.statusCode, challenge: response.headers['www-authenticate'] });
      });
      req.setTimeout(20_000, () => req.destroy(new Error('MCP request timed out.')));
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(result.status, 401, label);
    assert.equal(result.challenge, 'Bearer', label);
    console.log(`${label} returned HTTP 401.`);
  }

  await expectUnauthorized('Missing credential', []);
  await expectUnauthorized('Invalid bearer credential', ['Authorization', `Bearer ${invalidKey}`]);
  await expectUnauthorized('Invalid static credential', ['X-API-Key', invalidKey]);
  await expectUnauthorized('Malformed bearer with a valid static credential', ['Authorization', key, 'X-API-Key', key]);
  await expectUnauthorized('Conflicting credentials', ['Authorization', `Bearer ${key}`, 'X-API-Key', invalidKey]);
  await expectUnauthorized('Conflicting credentials with a valid static key', ['Authorization', `Bearer ${invalidKey}`, 'X-API-Key', key]);
  await expectUnauthorized('Duplicate Authorization headers', ['Authorization', `Bearer ${key}`, 'Authorization', `Bearer ${invalidKey}`]);
  await expectUnauthorized('Duplicate X-API-Key headers', ['X-API-Key', key, 'X-API-Key', invalidKey]);

  for (const [label, header, value] of [['Bearer', 'Authorization', `Bearer ${key}`], ['Static API Key', 'X-API-Key', key]]) {
    const headers = new Headers({ [header]: value });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    const client = new Client(clientInfo);
    try {
      await client.connect(transport);
      assert.ok(transport.sessionId, 'Initialization did not issue an MCP session.');
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), tools);
      const result = await client.callTool({ name: 'list_collections', arguments: {} });
      const data = result.structuredContent as { collections?: unknown } | undefined;
      assert.ok(!result.isError && Array.isArray(data?.collections), 'Atlas list_collections did not succeed.');
      await expectUnauthorized(`${label} session without a credential`, [], transport.sessionId);
      await expectUnauthorized(`${label} session with an invalid key`, ['X-API-Key', invalidKey], transport.sessionId);
      headers.set('Authorization', `Bearer ${key}`);
      headers.set('X-API-Key', key);
      assert.equal((await client.listTools()).tools.length, tools.length);
      console.log(`${label} initialized, listed all seven tools and ran list_collections against Atlas.`);
    } finally {
      await client.close();
    }
  }
}

try {
  await verify();
} catch {
  console.error('MCP authentication verification failed. Credential and response data were omitted.');
  process.exitCode = 1;
}
