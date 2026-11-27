import { setTimeout as delay } from 'node:timers/promises';
import { loadMcpConfiguration } from '../mcp/config.ts';

// Loaded only by the live test's STDIO child. Every request still goes to Voyage.
loadMcpConfiguration({ loadTenantKey: false });
const origin = new URL(process.env.VOYAGE_API_BASE || 'https://ai.mongodb.com/v1').origin;
const fetchDirect = globalThis.fetch;
let lastStart: number | undefined;
let nextStart = 0;
let queue = Promise.resolve();

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin) return fetchDirect(input, init);

  const dispatched = queue.then(async () => {
    await delay(Math.max(0, Math.ceil(nextStart - performance.now())));
    const started = performance.now();
    const gapMs = lastStart === undefined ? null : Math.floor(started - lastStart);
    lastStart = started;
    nextStart = started + 22_001;
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    // The application's timeout starts before the test queue. Give the network
    // its full timeout once this deliberately paced request actually starts.
    const response = await fetchDirect(input, { ...init, signal: AbortSignal.timeout(18_000) });
    if (response.status === 429) nextStart = Math.max(nextStart, performance.now() + 61_000);
    const rerank = url.pathname.endsWith('/rerank');
    const scores = rerank && response.ok ? (await response.clone().json()).data.map(
      (row: { relevance_score: number }) => row.relevance_score,
    ) : undefined;
    process.stderr.write(JSON.stringify({ voyage: rerank ? 'rerank' : 'embed', gapMs, status: response.status,
      candidateCount: rerank ? payload.documents.length : undefined, topK: rerank ? payload.top_k : undefined,
      scores, elapsedMs: Math.round(performance.now() - started) }) + '\n');
    return response;
  });
  queue = dispatched.then(() => {}, () => {});
  return dispatched;
};
