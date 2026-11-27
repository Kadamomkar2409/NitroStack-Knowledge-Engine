import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import type { Filter } from 'mongodb';
import { AppError, corpusOrigin, database, digest, embeddingModel, lexicalIndex, requireAdmin, vectorIndex, visibilityFor } from './db.ts';
import type { Identity } from './db.ts';
import { chunkText } from './chunk.ts';
import type { Passage } from './chunk.ts';
import { embed } from './providers.ts';

export interface Source { title: string; url?: string; path?: string }
export interface KnowledgeDocument {
  _id: string; tenantId: string; collectionId: string; visibility: string[]; version: string; sourceType: string;
  embeddingModel: string; checksum: string; source: Source; chunkCount: number; createdAt: Date; updatedAt: Date;
  status: 'pending' | 'indexed';
}
export interface Chunk extends Passage {
  _id: string; documentId: string; tenantId: string; collectionId: string; visibility: string[];
  version: string; sourceType: string; embeddingModel: string; embedding: number[]; title: string;
  createdAt: Date; updatedAt: Date;
}
export const documents = () => database().collection<KnowledgeDocument>('documents');
export const chunks = () => database().collection<Chunk>('chunks');
export const tenantFilter = (identity: Identity) => ({ tenantId: identity.tenantId, visibility: { $in: visibilityFor(identity) } });
export function collectionName(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(value)) {
    throw new AppError(400, 'invalid_collection', 'Use a collection name with lowercase letters, numbers and hyphens.');
  }
  return value;
}

function htmlToContent(html: string) {
  const $ = load(html);
  $('script,style,nav,footer,aside,button,svg,[hidden]').remove();
  const title = $('h1').first().text().trim() || $('title').text().trim();
  const body = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  body.find('h1,h2,h3,h4,h5,h6').each((_, node) => {
    $(node).before('\n' + '#'.repeat(Number(node.tagName[1])) + ' ').after('\n');
  });
  body.find('p,li,pre,br,blockquote,table,section,div').each((_, node) => { $(node).after('\n'); });
  return { title, text: body.text().replace(/\n{3,}/g, '\n\n') };
}

export async function fetchCorpusPage(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError(400, 'invalid_url', 'Enter a NitroStack docs URL.'); }
  if (url.origin !== corpusOrigin || url.username || url.password || !url.pathname.startsWith('/docs/')) {
    throw new AppError(400, 'invalid_url', `Use a page under ${corpusOrigin}/docs/.`);
  }
  url.search = '';
  url.hash = '';
  // The public docs root redirects via /docs. Use its fixed, allowed page directly.
  if (url.pathname === '/docs/') url.pathname = '/docs/getting-started/overview';
  let html: string;
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        throw new AppError(422, 'source_redirect', 'Use the final NitroStack docs page URL. Redirects are not followed.');
      }
      throw new AppError(422, 'source_unavailable', 'The docs page could not be loaded as HTML.');
    }
    html = await response.text();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'source_unavailable', 'The docs page could not be reached or read.');
  }
  if (html.length > 2_000_000) throw new AppError(413, 'source_too_large', 'The page is too large.');
  const parsed = htmlToContent(html);
  return { source: { title: parsed.title || url.pathname, url: url.href }, pages: [{ text: parsed.text }], type: 'html' };
}

export async function parseUpload(file: File) {
  if (file.size > 3_000_000) throw new AppError(413, 'file_too_large', 'Upload a file under 3 MB.');
  const extension = file.name.toLowerCase().split('.').at(-1);
  const source = { title: file.name, path: file.name };
  if (extension === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
      const result = await parser.getText();
      return { source, type: 'pdf', pages: result.pages.map(page => ({ text: page.text, page: page.num })) };
    } catch {
      throw new AppError(422, 'invalid_pdf', 'Text could not be extracted from this PDF.');
    } finally { await parser.destroy(); }
  }
  if (extension === 'html' || extension === 'htm') {
    const { title, text } = htmlToContent(await file.text());
    return { source: { ...source, title: title || source.title }, type: 'html', pages: [{ text }] };
  }
  if (extension === 'md' || extension === 'markdown' || extension === 'txt') {
    return { source, type: extension === 'txt' ? 'text' : 'markdown', pages: [{ text: await file.text() }] };
  }
  throw new AppError(400, 'unsupported_file', 'Choose a Markdown, PDF, HTML or plain text file.');
}

interface Input { source: Source; pages: { text: string; page?: number }[]; type: string }
export async function ingest(identity: Identity, collectionId: string, input: Input, visibility = ['tenant']) {
  requireAdmin(identity);
  collectionName(collectionId);
  if (!visibility.length || visibility.length > 20 || visibility.some(role => !/^[a-z0-9-]{1,40}$/.test(role))) {
    throw new AppError(400, 'invalid_visibility', 'Use valid role names for document visibility.');
  }
  const patterns = (process.env.REDACT_PATTERNS || '').split('\n').filter(Boolean).map(pattern => new RegExp(pattern, 'g'));
  const source = { ...input.source, title: patterns.reduce((title, pattern) => title.replace(pattern, '[REDACTED]'), input.source.title) };
  const passages = input.pages.flatMap(({ text, page }) => chunkText(
    patterns.reduce((value, pattern) => value.replace(pattern, '[REDACTED]'), text),
    Number(process.env.CHUNK_SIZE || 1600), Number(process.env.CHUNK_OVERLAP || 200), page,
  ));
  if (!passages.length) throw new AppError(422, 'empty_document', 'No readable text was found.');
  if (passages.length > 800) throw new AppError(413, 'too_many_chunks', 'Split this document into smaller files.');
  const model = embeddingModel();
  const normalizedVisibility = [...new Set(visibility)].sort();
  const id = digest(JSON.stringify([identity.tenantId, collectionId, source.url || source.path]));
  const checksum = digest(JSON.stringify([source.title, passages, normalizedVisibility, model]));
  const previous = await documents().findOne({ _id: id, ...tenantFilter(identity) });
  if (previous?.checksum === checksum) return { documentId: id, status: previous.status, changed: false };

  const version = randomUUID();
  const now = new Date();
  const shared = { tenantId: identity.tenantId, collectionId, visibility: normalizedVisibility, version, sourceType: input.type, embeddingModel: model };
  let publishing = false;
  let published = false;
  try {
    for (let offset = 0; offset < passages.length; offset += 32) {
      const batch = passages.slice(offset, offset + 32);
      const { vectors } = await embed(identity, batch.map(passage => passage.text), 'document');
      await chunks().insertMany(batch.map((passage, index) => ({
        ...passage, ...shared, _id: `${version}:${offset + index}`, documentId: id, title: source.title,
        embedding: vectors[index], createdAt: now, updatedAt: now,
      })));
    }
    const document: KnowledgeDocument = {
      ...shared, _id: id, source, checksum, status: 'pending', chunkCount: passages.length,
      createdAt: previous?.createdAt || now, updatedAt: now,
    };
    publishing = true;
    if (previous) {
      const update = await documents().replaceOne({ _id: id, tenantId: identity.tenantId, version: previous.version }, document);
      if (!update.modifiedCount) throw new AppError(409, 'concurrent_update', 'The document changed. Try again.');
    } else {
      try { await documents().insertOne(document); }
      catch (error) {
        if ((error as { code?: number }).code === 11000) throw new AppError(409, 'concurrent_update', 'This document already exists or is restricted.');
        throw error;
      }
    }
    published = true;
  } finally {
    // Preserve staged chunks if the database may have committed a write before the connection failed.
    const active = publishing && !published ? await documents().findOne({ _id: id, tenantId: identity.tenantId }) : null;
    if (!published && active?.version !== version) await chunks().deleteMany({ documentId: id, tenantId: identity.tenantId, version });
  }
  if (previous) await chunks().deleteMany({ documentId: id, tenantId: identity.tenantId, version: previous.version });
  return { documentId: id, status: 'pending', changed: true };
}

export async function deleteDocument(identity: Identity, id: string) {
  requireAdmin(identity);
  const document = await documents().findOneAndDelete({ _id: id, ...tenantFilter(identity) });
  if (!document) throw new AppError(404, 'document_not_found', 'Document not found.');
  await chunks().deleteMany({ documentId: id, tenantId: identity.tenantId, version: document.version });
  return { deleted: true };
}

export async function refreshStatus(identity: Identity, id: string) {
  const document = await documents().findOne({ _id: id, ...tenantFilter(identity) });
  if (!document) throw new AppError(404, 'document_not_found', 'Document not found.');
  if (document.status === 'indexed') return { documentId: id, status: document.status };
  const first = await chunks().findOne({ documentId: id, version: document.version, ...tenantFilter(identity) });
  if (!first) return { documentId: id, status: 'pending' };
  const indexes = await chunks().listSearchIndexes().toArray();
  if (![lexicalIndex, vectorIndex].every(name => indexes.some(index => index.name === name && ('queryable' in index && index.queryable === true)))) {
    return { documentId: id, status: 'pending' };
  }
  const queryable = await chunks().aggregate([
    { $vectorSearch: { index: vectorIndex, path: 'embedding', queryVector: first.embedding, filter: { version: document.version, ...tenantFilter(identity) }, exact: true, limit: document.chunkCount } },
    { $count: 'count' },
  ]).next();
  const lexical = await chunks().aggregate([
    { $searchMeta: { index: lexicalIndex, count: { type: 'total' }, compound: { filter: [
      { equals: { path: 'version', value: document.version } },
      { equals: { path: 'tenantId', value: identity.tenantId } },
      { in: { path: 'visibility', value: visibilityFor(identity) } },
    ] } } },
  ]).next();
  if (Number(queryable?.count) !== document.chunkCount || Number(lexical?.count?.total) !== document.chunkCount) {
    return { documentId: id, status: 'pending' };
  }
  const update = await documents().updateOne({ _id: id, version: document.version, ...tenantFilter(identity) }, { $set: { status: 'indexed' } });
  return { documentId: id, status: update.matchedCount ? 'indexed' : 'pending' };
}

export async function listDocuments(identity: Identity, collection?: string) {
  const filter: Filter<KnowledgeDocument> = tenantFilter(identity);
  if (collection) filter.collectionId = collectionName(collection);
  return documents().find(filter, { projection: { checksum: 0, tenantId: 0 } }).sort({ updatedAt: -1 }).limit(200).toArray();
}


