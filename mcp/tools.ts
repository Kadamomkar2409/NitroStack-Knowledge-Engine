import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolDecorator as Tool, z } from '@nitrostack/core';
import { AppError, requireAdmin } from '../backend/core/db.ts';
import type { Identity } from '../backend/core/db.ts';
import { deleteDocument, fetchCorpusPage, ingest, parseUpload } from '../backend/core/ingest.ts';
import { answer, collections, getSource, search, searchInput, usageSummary } from '../backend/core/retrieval.ts';

export const requestIdentity = new AsyncLocalStorage<Identity>();

const collection = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
const documentId = z.string().regex(/^[a-f0-9]{64}$/);
const chunkId = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:\d+$/);
const searchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  collection: collection.optional(),
  topK: z.number().int().min(1).max(20).optional(),
  mode: z.enum(['vector', 'hybrid']).optional(),
  rerank: z.boolean().optional(),
  rerankModel: z.enum(['rerank-3', 'rerank-3-lite']).optional(),
  candidates: z.number().int().min(1).max(60).optional(),
  exact: z.boolean().optional(),
  filters: z.object({
    sourceType: z.enum(['markdown', 'html', 'pdf', 'text']).optional(),
    version: z.string().uuid().optional(),
  }).strict().optional(),
}).strict();
const answerSchema = searchSchema.extend({ model: z.string().trim().min(1).max(200).optional() });
const sourceSchema = z.object({ documentId: documentId.optional(), chunkId: chunkId.optional() }).strict()
  .refine(args => Boolean(args.documentId) !== Boolean(args.chunkId), 'Provide exactly one document or chunk ID.');
const emptySchema = z.object({}).strict();
const deleteSchema = z.object({ documentId }).strict();
const usageSchema = z.object({ period: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }).strict();
const ingestSchema = z.object({
  collection,
  visibility: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).min(1).max(20).optional(),
  metadata: z.object({ title: z.string().trim().min(1).max(256).optional() }).strict().optional(),
  url: z.string().url().max(2048).optional(),
  file: z.object({
    name: z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f]+$/),
    base64: z.string().min(4).max(4_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict().optional(),
}).strict().refine(args => Boolean(args.url) !== Boolean(args.file), 'Provide exactly one URL or file.');

export function publicError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message, status: error.status };
  return { code: 'internal_error', message: 'The server could not complete this request.', status: 500 };
}

function toolResult(data: Record<string, unknown>, isError = false) {
  const structuredContent = JSON.parse(JSON.stringify(data));
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError };
}

async function execute<S extends z.ZodTypeAny>(schema: S, input: unknown,
  operation: (identity: Identity, args: z.output<S>) => Promise<Record<string, unknown>>) {
  try {
    const identity = requestIdentity.getStore();
    if (!identity) throw new AppError(401, 'unauthorized', 'Enter a valid workspace API key.');
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return toolResult({ error: { code: 'invalid_input', status: 400, message: 'Invalid tool arguments.',
        issues: parsed.error.issues.map(({ code, path }) => ({ code, path })) } }, true);
    }
    return toolResult(await operation(identity, parsed.data));
  } catch (error) {
    return toolResult({ error: publicError(error) }, true);
  }
}

export class KnowledgeTools {
  @Tool({ name: 'search_knowledge', description: 'Search authorized passages and return ranked sources.', inputSchema: searchSchema })
  search(input: unknown) {
    return execute(searchSchema, input, (identity, args) => search(identity, searchInput(args)));
  }

  @Tool({ name: 'answer_question', description: 'Answer with authorized citations or return no supported answer.', inputSchema: answerSchema })
  answer(input: unknown) {
    return execute(answerSchema, input, (identity, args) => answer(identity, searchInput(args), args.model));
  }

  @Tool({ name: 'get_source', description: 'Read authorized source passages by document or chunk ID.', inputSchema: sourceSchema })
  source(input: unknown) {
    return execute(sourceSchema, input, (identity, args) => getSource(identity, (args.documentId ?? args.chunkId)!));
  }

  @Tool({ name: 'list_collections', description: 'List collections and authorized document counts.', inputSchema: emptySchema })
  list(input: unknown) {
    return execute(emptySchema, input, async identity => ({ collections: await collections(identity) }));
  }

  @Tool({ name: 'ingest_document', description: 'Add or update a docs URL or a base64-encoded file. Requires an admin key.', inputSchema: ingestSchema })
  ingest(input: unknown) {
    return execute(ingestSchema, input, async (identity, args) => {
      requireAdmin(identity);
      const document = args.file ?
        await parseUpload(new File([Buffer.from(args.file.base64, 'base64')], args.file.name)) :
        await fetchCorpusPage(args.url!);
      if (args.metadata?.title) document.source.title = args.metadata.title;
      return ingest(identity, args.collection, document, args.visibility);
    });
  }

  @Tool({ name: 'delete_document', description: 'Delete an authorized document and its passages. Requires an admin key.', inputSchema: deleteSchema })
  delete(input: unknown) {
    return execute(deleteSchema, input, (identity, args) => deleteDocument(identity, args.documentId));
  }

  @Tool({ name: 'get_usage', description: 'Read usage totals for the caller over 7, 30, or 90 days.', inputSchema: usageSchema })
  usage(input: unknown) {
    return execute(usageSchema, input, async (identity, args) => ({ days: args.period, usage: await usageSummary(identity, args.period) }));
  }
}
