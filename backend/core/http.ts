import { AppError, authenticate, database, lexicalIndex, requireAdmin, vectorIndex } from './db.ts';
import { chunks, collectionName, deleteDocument, fetchCorpusPage, ingest, listDocuments, parseUpload, refreshStatus } from './ingest.ts';
import { models, requestProvider } from './providers.ts';
import { answer, collections, getSource, search, searchInput, usageSummary } from './retrieval.ts';

async function objectBody(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { throw new AppError(400, 'invalid_json', 'Provide a valid JSON request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_json', 'Provide a JSON object.');
  return body as Record<string, unknown>;
}

export async function handleApi(request: Request, path: string) {
  const started = performance.now();
  let tenant: string | undefined;
  let status = 200;
  let errorCode: string | undefined;
  let resultCount: number | undefined;
  const json = (body: unknown, code = 200) => {
    status = code;
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  };
  try {
    const identity = await authenticate(request.headers.get('authorization'));
    tenant = identity.tenantId;
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (path === 'session') return json({ tenantId: identity.tenantId, admin: identity.roles.includes('admin'), models: models() });
      if (path === 'collections') return json({ collections: await collections(identity) });
      if (path === 'documents') return json({ documents: await listDocuments(identity, url.searchParams.get('collection') || undefined) });
      if (path === 'usage') {
        const days = Number(url.searchParams.get('days') || 30);
        if (![7, 30, 90].includes(days)) throw new AppError(400, 'invalid_period', 'Choose 7, 30 or 90 days.');
        return json({ days, usage: await usageSummary(identity, days) });
      }
      if (path === 'eval/runs') {
        return json({ runs: await database().collection('eval_runs').find({ tenantId: identity.tenantId }, { projection: { tenantId: 0 } })
          .sort({ timestamp: -1 }).limit(100).toArray() });
      }
      if (path === 'health') {
        const probes = await Promise.allSettled([
          database().command({ ping: 1 }),
          chunks().listSearchIndexes().toArray().then(indexes => {
            if (![lexicalIndex, vectorIndex].every(name => indexes.some(index => index.name === name && ('queryable' in index && index.queryable === true)))) throw Error('Index not queryable');
          }),
          requestProvider('voyage', '/embeddings', { model: process.env.EMBEDDING_MODEL || 'voyage-4', input: ['NitroStack'], input_type: 'query' }),
          requestProvider('openrouter', '/key'),
        ]);
        const checks = Object.fromEntries(['atlas', 'searchIndexes', 'voyage', 'openRouter'].map((name, i) => [name, probes[i].status === 'fulfilled']));
        const ok = Object.values(checks).every(Boolean);
        return json({ status: ok ? 'healthy' : 'degraded', checks }, ok ? 200 : 503);
      }
      const documentStatus = /^documents\/([a-f0-9]{64})\/status$/.exec(path);
      if (documentStatus) return json(await refreshStatus(identity, documentStatus[1]));
      const source = /^sources\/([a-f0-9:-]{36,80})$/.exec(path);
      if (source) return json(await getSource(identity, source[1]));
    }
    if (request.method === 'POST') {
      if (path === 'search' || path === 'answer') {
        const input = await objectBody(request);
        const options = searchInput(input);
        const result = path === 'search' ? await search(identity, options) : await answer(identity, options, input.model);
        resultCount = result.results.length;
        return json(result);
      }
      if (path === 'ingest') {
        requireAdmin(identity);
        if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
          const body = await request.formData();
          const file = body.get('file');
          if (!(file instanceof File)) throw new AppError(400, 'file_required', 'Select a file to upload.');
          const visibility = body.get('visibility');
          return json(await ingest(identity, collectionName(body.get('collection')), await parseUpload(file),
            typeof visibility === 'string' && visibility ? visibility.split(',').map(role => role.trim()) : undefined), 202);
        }
        const input = await objectBody(request);
        if (typeof input.url !== 'string') throw new AppError(400, 'url_required', 'Provide a NitroStack documentation page URL.');
        const visibility = input.visibility;
        if (visibility !== undefined && (!Array.isArray(visibility) || !visibility.every(role => typeof role === 'string'))) {
          throw new AppError(400, 'invalid_visibility', 'Visibility must be a list of roles.');
        }
        return json(await ingest(identity, collectionName(input.collection), await fetchCorpusPage(input.url), visibility), 202);
      }
    }
    if (request.method === 'DELETE') {
      const document = /^documents\/([a-f0-9]{64})$/.exec(path);
      if (document) return json(await deleteDocument(identity, document[1]));
    }
    throw new AppError(404, 'route_not_found', 'This endpoint does not exist.');
  } catch (error) {
    const known = error instanceof AppError;
    errorCode = known ? error.code : 'internal_error';
    if (!known) console.error(JSON.stringify({ route: path, error: error instanceof Error ? error.name : 'UnknownError' }));
    return json({ error: { code: errorCode, message: known ? error.message : 'The backend could not complete this request.' } }, known ? error.status : 500);
  } finally {
    console.info(JSON.stringify({ route: path, method: request.method, tenant, status, resultCount, errorCode,
      latencyMs: Math.round(performance.now() - started) }));
  }
}

