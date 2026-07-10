// Runs before everything else (first import in server.js):
// 1. loads .env if present (no dependency), without overriding real env vars
// 2. routes Node fetch through an egress proxy only when one is configured
//    (needed in the Claude Code sandbox; a no-op on a laptop or normal host)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const envFile = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fine */ }

if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY) {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
