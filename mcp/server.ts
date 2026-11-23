import 'reflect-metadata';
import { McpApp, McpApplicationFactory, Module } from '@nitrostack/core';
import type { NitroStackServer } from '@nitrostack/core';
import { AppError, authenticate, closeDatabase, digest } from '../backend/core/db.ts';
import { KnowledgeTools, publicError, requestIdentity } from './tools.ts';

let server: NitroStackServer;

class KnowledgeHttpAuthentication {
  onApplicationBootstrap() {
    const app = server.getHttpTransport()?.getApp?.();
    if (!app) throw new Error('Knowledge MCP requires the NitroStack HTTP transport.');

    // The SDK can populate its metadata from client input and retain headers in a session.
    // Authenticate each actual HTTP request and keep its identity outside that metadata.
    const sessions = new Map<string, { keyHash: string; expires: number }>();
    const sessionLifetime = 30 * 60 * 1000;
    app.all(['/sse', '/mcp/messages'], (_request, response) => {
      response.status(404).json({ error: { code: 'route_not_found', message: 'Use Streamable HTTP at /mcp.' } });
    });
    app.all('/mcp', async (request, response, next) => {
      try {
        const authorization = request.get('authorization') ?? null;
        const identity = await authenticate(authorization);
        const keyHash = digest(authorization!.substring(7));
        const sessionId = request.get('mcp-session-id');
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session || session.keyHash !== keyHash || session.expires <= Date.now()) {
            throw new AppError(404, 'session_not_found', 'MCP session not found.');
          }
          session.expires = Date.now() + sessionLifetime;
          if (request.method === 'DELETE') response.once('finish', () => {
            if (response.statusCode < 300) sessions.delete(sessionId);
          });
        } else {
          for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
          // Bind the ID the transport issued before a subsequent request can use it.
          response.once('finish', () => {
            const issuedId = response.getHeader('mcp-session-id');
            if (typeof issuedId === 'string' && response.statusCode < 300) {
              sessions.set(issuedId, { keyHash, expires: Date.now() + sessionLifetime });
            }
          });
        }
        requestIdentity.run(identity, next);
      } catch (failure) {
        const error = publicError(failure);
        if (error.status === 401) response.set('WWW-Authenticate', 'Bearer');
        response.status(error.status).json({ error });
      }
    });
  }

  onApplicationShutdown() {
    return closeDatabase();
  }
}

@McpApp({
  module: KnowledgeModule,
  server: { name: 'nitrostack-knowledge-engine', version: '0.1.0', protocolVersion: '2025-06-18' },
  transport: { type: 'http' },
})
@Module({ name: 'knowledge', controllers: [KnowledgeTools], providers: [KnowledgeHttpAuthentication] })
class KnowledgeModule {}

export async function startKnowledgeServer(port = Number(process.env.MCP_PORT ?? 3001)) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_PORT must be a valid TCP port.');
  server = await McpApplicationFactory.create(KnowledgeModule);
  await server.start({ transport: 'http', host: '127.0.0.1', port, enableCors: false });
  return server;
}
