import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { closeDatabase, database, digest, lexicalIndex, vectorIndex } from '../backend/core/db.ts';

const tenantId = process.argv[2] || 'nitrostack';
if (!/^[a-z0-9-]{2,60}$/.test(tenantId)) throw new Error('Use a lowercase tenant identifier.');
const keyPath = `.env.tenant-${tenantId}`;
try {
  const db = database();
  await db.command({ ping: 1 });
  await db.collection('tenants').createIndex({ apiKeyHash: 1 }, { unique: true });
  await db.collection('tenants').createIndex({ tenantId: 1 });
  await db.collection('documents').createIndex({ tenantId: 1, collectionId: 1, visibility: 1 });
  const chunks = db.collection('chunks');
  await chunks.createIndex({ tenantId: 1, documentId: 1, version: 1 });
  await db.collection('usage').createIndex({ tenantId: 1, timestamp: -1 });
  await db.collection('eval_runs').createIndex({ tenantId: 1, timestamp: -1 });
  const indexes = await chunks.listSearchIndexes().toArray();
  const filterPaths = ['tenantId', 'collectionId', 'visibility', 'version', 'sourceType', 'embeddingModel'];
  if (!indexes.some(index => index.name === vectorIndex)) {
    await chunks.createSearchIndex({
      name: vectorIndex, type: 'vectorSearch',
      definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
        ...filterPaths.map(path => ({ type: 'filter', path }))] },
    });
  }
  if (!indexes.some(index => index.name === lexicalIndex)) {
    await chunks.createSearchIndex({
      name: lexicalIndex, type: 'search',
      definition: { mappings: { dynamic: false, fields: {
        ...Object.fromEntries(filterPaths.map(path => [path, { type: 'token' }])),
        text: { type: 'string' }, title: { type: 'string' },
      } } },
    });
  }
  let key: string;
  try { key = (await readFile(keyPath, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = randomBytes(32).toString('base64url');
    await writeFile(keyPath, key + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid tenant key file.');
  await db.collection('tenants').updateOne({ apiKeyHash: digest(key) },
    { $setOnInsert: { tenantId, apiKeyHash: digest(key), roles: ['admin'], createdAt: new Date() } }, { upsert: true });
  console.log(`Atlas setup submitted for ${tenantId}. Workspace key saved to ${keyPath}. Search indexes build asynchronously.`);
} catch (error) {
  console.error('Setup failed:', error instanceof Error ? error.name + ' ' + (('code' in error && error.code) || error.message) : 'unknown error');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
