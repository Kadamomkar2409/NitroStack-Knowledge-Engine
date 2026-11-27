import 'reflect-metadata';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpApp, McpApplicationFactory, Module } from '@nitrostack/core';
import { AppError, authenticateKeyHash, closeDatabase } from '../backend/core/db.ts';
import { loadMcpConfiguration } from './config.ts';
import { KnowledgeTools, requestIdentity } from './tools.ts';
import { readWorkspaceCredentialHash } from './windows-credential.ts';

@McpApp({
  module: KnowledgeStdioModule,
  server: { name: 'nitrostack-knowledge-engine', version: '0.1.0', protocolVersion: '2025-06-18' },
  transport: { type: 'stdio' },
  shutdownHooks: false,
})
@Module({ name: 'knowledge', controllers: [KnowledgeTools] })
class KnowledgeStdioModule {}

async function run() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || !Number.isInteger(patch) || minor < 22 || (minor === 22 && patch < 3)) {
    throw new AppError(503, 'unsupported_runtime', 'Use Node.js 24.22.3 or a later Node.js 24 patch release.');
  }
  const keyHash = await readWorkspaceCredentialHash();
  loadMcpConfiguration({ loadTenantKey: false });
  const verifyWorkspace = () => authenticateKeyHash(keyHash, AbortSignal.timeout(10_000));
  const { tenantId } = await verifyWorkspace();
  const app = await McpApplicationFactory.create(KnowledgeStdioModule);
  const mcp = app.createConfiguredMcpServer();
  const stdio = new StdioServerTransport();
  let stopping = false;
  let pending = 0;
  let queue = Promise.resolve();

  async function shutdown(exitCode = 0, message?: string) {
    if (stopping) return;
    stopping = true;
    try {
      await mcp.close();
      await Promise.all([app.stop(), closeDatabase()]);
    } catch {
      exitCode = 1;
      message ??= 'Knowledge MCP STDIO could not shut down cleanly.';
    }
    if (message) await writeDiagnostic(message);
    process.exit(exitCode);
  }

  // NitroStack builds the protocol server and tool handlers. Gate the public MCP
  // transport before it can dispatch initialize or any later client message.
  const transport: Transport = {
    start: () => stdio.start(),
    send: message => stdio.send(message),
    close: () => stdio.close(),
  };
  stdio.onclose = () => {
    transport.onclose?.();
    void shutdown();
  };
  stdio.onerror = () => void shutdown(1, 'Knowledge MCP STDIO transport failed.');
  stdio.onmessage = message => {
    if (stopping) return;
    if (pending >= 32) {
      void shutdown(1, 'Knowledge MCP STDIO received too many pending messages.');
      return;
    }
    pending++;
    queue = queue.then(async () => {
      if (stopping) return;
      const identity = await verifyWorkspace();
      if (stopping) return;
      if (identity.tenantId !== tenantId) throw new Error('Workspace changed.');
      requestIdentity.run(identity, () => transport.onmessage?.(message));
    }).catch(() => shutdown(1, 'Knowledge MCP STDIO could not validate the workspace credential.'))
      .finally(() => { pending--; });
  };

  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
  process.stdout.once('error', () => void shutdown(1));
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    await mcp.connect(transport);
  } catch {
    await shutdown(1, 'Knowledge MCP STDIO could not start the transport.');
  }
}

function writeDiagnostic(message: string) {
  return new Promise<void>(resolve => process.stderr.write(`${message}\n`, () => resolve()));
}

try {
  await run();
} catch (error) {
  await closeDatabase().catch(() => {});
  const message = error instanceof AppError && ['unsupported_runtime', 'windows_credential', 'unauthorized'].includes(error.code) ? error.message :
    'Knowledge MCP STDIO could not start. Check the Windows vault credential and Atlas connectivity.';
  await writeDiagnostic(message);
  process.exit(1);
}
