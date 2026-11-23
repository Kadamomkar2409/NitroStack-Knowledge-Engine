import { AppError, database, embeddingModel, env } from './db.ts';
import type { Identity } from './db.ts';

export interface Usage { provider: string; model: string; tokens: number | null; cost: number | null }
type Provider = 'voyage' | 'openrouter';

export async function requestProvider<T>(provider: Provider, path: string, body?: unknown): Promise<T> {
  const base = provider === 'voyage' ? process.env.VOYAGE_API_BASE || 'https://ai.mongodb.com/v1' : 'https://openrouter.ai/api/v1';
  const key = env(provider === 'voyage' ? 'VOYAGE_API_KEY' : 'OPENROUTER_API_KEY');
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(18000),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      if (attempt === 0) continue;
      throw new AppError(502, 'provider_unavailable', `${provider} could not be reached.`);
    }
    if (response.ok) return response.json() as Promise<T>;
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      const header = response.headers.get('retry-after');
      const delay = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 900;
      if (response.status === 429 && delay > 4000) throw new AppError(429, 'provider_rate_limited', `${provider} is temporarily rate limited. Try again shortly.`);
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(delay) ? Math.max(0, delay) : 900));
      continue;
    }
    throw new AppError(response.status === 429 ? 429 : 502, 'provider_error', `${provider} returned HTTP ${response.status}.`);
  }
  throw new AppError(502, 'provider_unavailable', `${provider} could not be reached.`);
}

const voyageRates: Record<string, number> = {
  'voyage-4-lite': 0.02, 'voyage-4': 0.06, 'voyage-4-large': 0.12, 'voyage-code-4': 0.12,
  'rerank-3-lite': 0.02, 'rerank-3': 0.05,
};
export async function recordUsage(identity: Identity, operation: string, provider: Provider, model: string,
  raw: { total_tokens?: number; cost?: number } = {}): Promise<Usage> {
  const tokens = typeof raw.total_tokens === 'number' ? raw.total_tokens : null;
  const rate = voyageRates[model];
  const cost = typeof raw.cost === 'number' ? raw.cost :
    provider === 'voyage' && tokens !== null && rate !== undefined ? tokens * rate / 1_000_000 : null;
  const usage = { provider, model, tokens, cost };
  await database().collection('usage').insertOne({ ...usage, operation, tenantId: identity.tenantId, timestamp: new Date() });
  return usage;
}

export async function embed(identity: Identity, input: string[], type: 'query' | 'document') {
  const model = embeddingModel();
  const response = await requestProvider<{ data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } }>('voyage', '/embeddings', {
    input, model, input_type: type, output_dimension: 1024,
  });
  const vectors = response.data.sort((a, b) => a.index - b.index).map(row => row.embedding);
  if (vectors.length !== input.length || vectors.some(vector => vector.length !== 1024 || !vector.every(Number.isFinite))) {
    throw new AppError(502, 'invalid_embedding', 'The embedding provider returned an unexpected vector.');
  }
  const usage = await recordUsage(identity, type === 'query' ? 'search' : 'ingest', 'voyage', model, response.usage);
  return { vectors, usage };
}

export function models() {
  return [...new Set([env('LLM_MODEL'), ...(process.env.LLM_MODELS || '').split(',').map(id => id.trim()).filter(Boolean)])];
}
