import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../backend/core/chunk.ts';
import { authenticate, requireAdmin } from '../backend/core/db.ts';
import { indexFilters, searchInput } from '../backend/core/retrieval.ts';

test('chunking keeps the heading path and page number', () => {
  const chunks = chunkText('# Parent\r\n## Child\r\nbody content', 500, 100, 3);
  assert.equal(chunks[1].sectionPath, 'Parent / Child');
  assert.equal(chunks[1].page, 3);
  assert.match(chunks[1].text, /body content/);
});

test('chunk lengths stay bounded and invalid overlaps fail', () => {
  const chunks = chunkText('A paragraph with a sequence of words. '.repeat(100), 350, 60);
  assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.text.length <= 350));
  assert.throws(() => chunkText('text', 350, 175), { code: 'invalid_chunk_settings' });
});

test('both indexes apply server-derived tenant, visibility and collection filters', () => {
  const identity = { tenantId: 'workspace-a', roles: ['reader'] };
  const options = searchInput({ query: 'index', collection: 'manuals', tenantId: 'workspace-b' });
  const { vector, lexical } = indexFilters(identity, options);
  assert.equal(vector.tenantId, identity.tenantId);
  assert.deepEqual(vector.visibility, { $in: ['tenant', 'reader'] });
  assert.ok(lexical.some(filter => 'equals' in filter && filter.equals.path === 'tenantId' && filter.equals.value === identity.tenantId));
  assert.equal(vector.collectionId, 'manuals');
});

test('absent identity and non-admin mutations fail closed', async () => {
  await assert.rejects(authenticate(null), { code: 'unauthorized' });
  assert.throws(() => requireAdmin({ tenantId: 'workspace-a', roles: ['reader'] }), { code: 'forbidden' });
  assert.throws(() => searchInput({ query: 'index', collection: { $ne: '' } }), { code: 'invalid_collection' });
});
