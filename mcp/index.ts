import { setImmediate } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadMcpConfiguration, redactConfiguration } from './config.ts';

async function exitWithError(action: 'start' | 'stop', error: unknown) {
  const message = error instanceof Error ? redactConfiguration(error.message) : 'Unknown error.';
  await new Promise<void>(resolve => process.stderr.write(`Knowledge MCP could not ${action}: ${message}\n`, () => resolve()));
  process.exit(1);
}

try {
  const mode = process.argv[2];
  const production = mode === '--production';
  const development = mode === '--development';
  if (production || development) Object.assign(process.env, { NODE_ENV: production ? 'production' : 'development' });
  loadMcpConfiguration();
  let port: number | undefined;
  if (production || development) {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { port: { type: 'string' } } });
    const configuredPort = production ? process.env.MCP_SERVER_PORT ?? process.env.PORT ?? process.env.MCP_PORT ?? '3000' : undefined;
    const requestedPort = values.port ?? configuredPort;
    if (requestedPort !== undefined) port = Number(requestedPort);
  }
  const { startKnowledgeServer } = await import('./server.ts');
  const server = await startKnowledgeServer(port, { shutdownHooks: false });

  // The SDK shuts down HTTP and Atlas, but its rate limiter keeps a process-wide timer alive.
  let stopping = false;
  async function shutdown(signal: NodeJS.Signals) {
    if (stopping) return;
    stopping = true;
    try {
      await server.stop(signal);
      // The SDK schedules its log writes with setImmediate.
      await setImmediate();
      await new Promise<void>(resolve => process.stderr.write('', () => resolve()));
      process.exit(0);
    } catch (error) {
      await exitWithError('stop', error);
    }
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  await exitWithError('start', error);
}
