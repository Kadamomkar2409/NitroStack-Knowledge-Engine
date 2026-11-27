import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const tools = ['answer_question', 'delete_document', 'get_source', 'get_usage', 'ingest_document', 'list_collections', 'search_knowledge'];
const expectMissing = process.argv[2] === '--expect-missing';
const entry = fileURLToPath(new URL('../dist/mcp/stdio.js', import.meta.url));
const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const exit = once(child, 'close');
const deadline = setTimeout(() => child.kill(), 45_000);
let diagnostic = '';
child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
child.stdin.on('error', () => {});

try {
  if (expectMissing) {
    let stdoutBytes = 0;
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'knowledge-stdio-check', version: '1.0.0' },
    } })}\n`);
    assert.deepEqual(await exit, [1, null]);
    assert.equal(stdoutBytes, 0);
    assert.match(diagnostic, /Provision a valid KnowledgeEngine-MCP-STDIO Generic Credential/);
    console.log('Missing Windows credential rejected before MCP initialization.');
  } else {
    // The SDK's line transport only needs readable and writable streams. Attach it to
    // the child pipes so the test can also assert the actual exit code after EOF.
    const client = new Client({ name: 'knowledge-stdio-check', version: '1.0.0' });
    const transport = new StdioServerTransport(child.stdout, child.stdin);
    child.once('close', () => void transport.close());
    const options = { timeout: 25_000 };
    try {
      await client.connect(transport, options);
      assert.equal(client.getServerVersion()?.name, 'nitrostack-knowledge-engine');
      console.log('MCP initialization passed.');
      assert.deepEqual((await client.listTools(undefined, options)).tools.map(tool => tool.name).sort(), tools);
      console.log('All seven MCP tools discovered.');
      const result = await client.callTool({ name: 'list_collections', arguments: {} }, undefined, options);
      const data = result.structuredContent as { collections?: unknown } | undefined;
      assert.ok(!result.isError && Array.isArray(data?.collections));
      console.log('Authorized Atlas list_collections passed.');
    } finally {
      child.stdin.end();
      await client.close();
    }
    assert.deepEqual(await exit, [0, null]);
    console.log('Server exited cleanly on STDIO EOF.');
  }
} catch {
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (diagnostic.includes('Provision a valid KnowledgeEngine-MCP-STDIO Generic Credential')) {
    console.error('The Windows vault credential is missing or malformed.');
  }
  console.error('MCP STDIO verification failed. Diagnostic and response data were omitted.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
