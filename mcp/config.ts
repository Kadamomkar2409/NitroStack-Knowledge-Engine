import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { config, parse, populate } from 'dotenv';

const tenantKeyName = 'NITROSTACK_TENANT_API_KEY';

export function loadMcpConfiguration() {
  // Both the source and compiled entry points use configuration at the package root.
  const manifest = findPackageJSON(import.meta.url);
  if (!manifest) throw new Error('Could not locate the Knowledge MCP package root.');
  const root = dirname(manifest);
  config({ path: join(root, '.env.local'), quiet: true });
  try {
    const source = readFileSync(join(root, '.env.tenant-nitrostack'), 'utf8').trim();
    // Setup writes a single raw key. Support a dotenv assignment as well.
    const value = /^[A-Za-z0-9_-]{32,128}$/.test(source) ? source : parse(source)[tenantKeyName];
    if (value) populate(process.env, { [tenantKeyName]: value });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load the NitroStack tenant key.');
  }
}

export function redactConfiguration(message: string) {
  const secrets = [process.env.MONGODB_URI, process.env.VOYAGE_API_KEY, process.env.OPENROUTER_API_KEY, process.env[tenantKeyName]];
  try {
    const uri = new URL(process.env.MONGODB_URI ?? '');
    secrets.push(uri.hostname, uri.password, decodeURIComponent(uri.password));
  } catch { /* The URI is either missing or already covered above. */ }
  for (const secret of secrets) if (secret) message = message.split(secret).join('[REDACTED]');
  return message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, '[REDACTED MONGODB URI]');
}
