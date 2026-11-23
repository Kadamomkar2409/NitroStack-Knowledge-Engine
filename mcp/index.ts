import { startKnowledgeServer } from './server.ts';

try {
  await startKnowledgeServer();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown startup error.';
  await new Promise<void>(resolve => process.stderr.write(`Knowledge MCP could not start: ${message}\n`, () => resolve()));
  process.exit(1);
}
