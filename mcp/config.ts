import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, parse, populate } from 'dotenv';

const tenantKeyName = 'NITROSTACK_TENANT_API_KEY';

export function loadMcpConfiguration() {
  config({ path: fileURLToPath(new URL('../.env.local', import.meta.url)), quiet: true });
  try {
    const source = readFileSync(new URL('../.env.tenant-nitrostack', import.meta.url), 'utf8').trim();
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
