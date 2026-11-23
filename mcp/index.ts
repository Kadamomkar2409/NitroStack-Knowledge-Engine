import { loadMcpConfiguration, redactConfiguration } from './config.ts';
import { startKnowledgeServer } from './server.ts';

try {
  loadMcpConfiguration();
  await startKnowledgeServer();
} catch (error) {
  const message = error instanceof Error ? redactConfiguration(error.message) : 'Unknown startup error.';
  await new Promise<void>(resolve => process.stderr.write(`Knowledge MCP could not start: ${message}\n`, () => resolve()));
  process.exit(1);
}
