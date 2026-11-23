import { parseArgs } from 'node:util';
import { loadMcpConfiguration, redactConfiguration } from './config.ts';

try {
  const production = process.argv[2] === '--production';
  if (production) Object.assign(process.env, { NODE_ENV: 'production' });
  loadMcpConfiguration();
  let port: number | undefined;
  if (production) {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { port: { type: 'string' } } });
    port = Number(values.port ?? process.env.MCP_SERVER_PORT ?? process.env.PORT ?? process.env.MCP_PORT ?? 3000);
  }
  const { startKnowledgeServer } = await import('./server.ts');
  await startKnowledgeServer(port);
} catch (error) {
  const message = error instanceof Error ? redactConfiguration(error.message) : 'Unknown startup error.';
  await new Promise<void>(resolve => process.stderr.write(`Knowledge MCP could not start: ${message}\n`, () => resolve()));
  process.exit(1);
}
