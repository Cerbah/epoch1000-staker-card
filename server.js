// Epoch 1000 staking performance PoC — local server.
// Serves the page and a /api/report endpoint backed by Helius + Marinade APIs,
// with a file cache so no wallet is ever replayed twice (step 5).

import './lib/bootstrap.js'; // .env + optional egress proxy — must stay the first import
import http from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from './lib/pipeline.js';
import { rpc } from './lib/rpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');   // per-wallet reports — kept forever, TTL only gates freshness
const DATA_DIR = path.join(__dirname, 'data');     // long-term append-only log of every wallet check
const CACHE_TTL_MS = 6 * 3600 * 1000;
const PORT = process.env.PORT || 4180;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const inflight = new Map(); // wallet → Promise, dedupes concurrent checks

async function logCheck(entry) {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(path.join(DATA_DIR, 'checks.jsonl'), JSON.stringify(entry) + '\n');
}

async function report(wallet, force = false) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${wallet}.json`);
  if (!force && existsSync(file)) {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - Date.parse(cached.generatedAt) < CACHE_TTL_MS) {
      logCheck({ t: new Date().toISOString(), wallet, cache: 'hit' }).catch(() => {});
      return { ...cached, meta: { ...cached.meta, cache: 'hit' } };
    }
  }
  if (!inflight.has(wallet)) {
    inflight.set(wallet, buildReport(wallet)
      .then(async (r) => {
        await writeFile(file, JSON.stringify(r));
        logCheck({ t: r.generatedAt, wallet, cache: 'build', source: r.meta.rewardsSource, earnedSol: r.card.earnedSol, stakeAccounts: r.meta.stakeAccounts }).catch(() => {});
        return r;
      })
      .finally(() => inflight.delete(wallet)));
  }
  return inflight.get(wallet);
}

let epochCache = { t: 0, data: null };
async function epochInfo() {
  if (Date.now() - epochCache.t > 30_000) {
    epochCache = { t: Date.now(), data: await rpc('getEpochInfo') };
  }
  return { ...epochCache.data, fetchedAt: epochCache.t };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/report') {
      const wallet = (url.searchParams.get('wallet') || '').trim();
      if (!B58.test(wallet)) return json(res, 400, { error: 'invalid wallet address' });
      const t0 = Date.now();
      const r = await report(wallet, url.searchParams.get('force') === '1');
      r.meta.ms = Date.now() - t0;
      return json(res, 200, r);
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/epoch') return json(res, 200, await epochInfo());
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(path.join(__dirname, 'public', 'index.html')));
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    console.error(`[server] ${url.pathname}:`, err);
    json(res, 500, { error: err.message });
  }
});

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, () => console.log(`epoch1000 PoC → http://localhost:${PORT}`));
