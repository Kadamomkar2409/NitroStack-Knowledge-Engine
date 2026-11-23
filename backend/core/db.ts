import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';

export class AppError extends Error {
  readonly status: number; 
  readonly code: string; 
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export function env(name: string) {
  const value = process.env[name];
  if (!value) throw new AppError(503, 'configuration_missing', `Configure ${name} on the server.`);
  return value;
}

export const embeddingModel = () => process.env.EMBEDDING_MODEL || 'voyage-4';
export const vectorIndex = 'knowledge_vector';
export const lexicalIndex = 'knowledge_text';
export const corpusOrigin = 'https://docs.nitrostack.ai';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let client: MongoClient | undefined;

export function database() {
  const name = env('MONGODB_DB');
  client ??= new MongoClient(env('MONGODB_URI'), { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
  return client.db(name);
}

export async function closeDatabase() {
  await client?.close();
  client = undefined;
}

export interface Identity {
  tenantId: string;
  roles: string[];
}

export async function authenticate(header: string | null): Promise<Identity> {
  const token = header?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/i)?.[1];
  if (!token) throw new AppError(401, 'unauthorized', 'Enter a valid workspace API key.');
  const identity = await database().collection<Identity & { apiKeyHash: string }>('tenants').findOne({ apiKeyHash: digest(token) });
  if (!identity || typeof identity.tenantId !== 'string' || !Array.isArray(identity.roles) || !identity.roles.every(role => typeof role === 'string')) {
    throw new AppError(401, 'unauthorized', 'Enter a valid workspace API key.');
  }
  return { tenantId: identity.tenantId, roles: identity.roles };
}

export const visibilityFor = (identity: Identity) => ['tenant', ...identity.roles];
export function requireAdmin(identity: Identity) {
  if (!identity.roles.includes('admin')) throw new AppError(403, 'forbidden', 'A workspace admin key is required.');
}

