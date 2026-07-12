#!/usr/bin/env node
// Backfill exact historical per-LST SOL rates into lib/lst-rate-history.json (schema v2,
// symbol-major) from DefiLlama daily USD prices: rate(e) = LST_usd(t_e) / SOL_usd(t_e).
// Epoch→unix comes from sampled archival getBlockTime anchors (piecewise-linear). One-shot;
// the cron (record-rates.js) extends it forward. Optional args = symbols to limit (testing).
import '../lib/bootstrap.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '../lib/rpc.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'lib', 'lst-rate-history.json');
const REG = JSON.parse(readFileSync(path.join(ROOT, 'lib', 'lst-mints.json'), 'utf8'));
const WSOL = 'So11111111111111111111111111111111111111112';
const SPE = 432_000, START_EPOCH = 200;

const only = process.argv.slice(2);
const lsts = REG.filter((l) => !only.length || only.includes(l.symbol));
const nowEpoch = (await rpc('getEpochInfo')).epoch;

// epoch → unix via sampled getBlockTime (probe nearby slots when one was skipped)
async function blockTimeNear(slot) {
  for (let d = 0; d <= 3000; d += 250) for (const s of [slot + d, slot - d]) {
    if (s < 0) continue;
    const r = await rpc('getBlockTime', [s]).catch(() => null);
    if (typeof r === 'number') return r;
  }
  return null;
}
const anchors = [];
for (let e = START_EPOCH; e <= nowEpoch; e += 40) { const t = await blockTimeNear(e * SPE); if (t) anchors.push({ e, t }); }
{ const t = await blockTimeNear(nowEpoch * SPE); if (t && anchors[anchors.length - 1].e !== nowEpoch) anchors.push({ e: nowEpoch, t }); }
const epochToUnix = (e) => {
  let a = anchors[0], b = anchors[1];
  for (let i = 1; i < anchors.length; i++) { if (e <= anchors[i].e) { a = anchors[i - 1]; b = anchors[i]; break; } a = anchors[i - 1]; b = anchors[i]; }
  return a.t + (e - a.e) * (b.t - a.t) / (b.e - a.e);
};

// DefiLlama daily USD prices, chunked (max 500 points/request), ascending
async function dailyUsd(mint) {
  const out = []; let start = 1640995200; // 2022-01-01
  const now = Date.now() / 1000;
  for (let g = 0; g < 40; g++) {
    const j = await fetch(`https://coins.llama.fi/chart/solana:${mint}?start=${start}&span=500&period=1d`).then((r) => r.ok ? r.json() : null).catch(() => null);
    const ps = j?.coins?.[`solana:${mint}`]?.prices;
    if (!ps?.length) break;
    for (const p of ps) if (!out.length || p.timestamp > out[out.length - 1].timestamp) out.push(p);
    const last = ps[ps.length - 1].timestamp;
    if (last >= now - 2 * 86400) break;            // reached ~today
    start = last > start ? last + 86400 : start + 400 * 86400; // advance (jump if stalled)
  }
  return out;
}
const priceAt = (s, ts) => {
  if (!s.length || ts < s[0].timestamp - 3 * 86400) return null;
  if (ts >= s[s.length - 1].timestamp) return s[s.length - 1].price;
  let lo = 0, hi = s.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (s[m].timestamp <= ts) lo = m; else hi = m; }
  return s[lo].price;
};

const sol = await dailyUsd(WSOL);
if (sol.length < 10) throw new Error('DefiLlama SOL price series unavailable');
const hist = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const rates = hist.schemaVersion === 2 && hist.rates ? hist.rates : {};

for (const l of lsts) {
  const series = await dailyUsd(l.mint);
  if (!series.length) { console.error('  no DefiLlama data:', l.symbol); continue; }
  const firstTs = series[0].timestamp;
  const m = rates[l.symbol] || (rates[l.symbol] = {});
  let filled = 0;
  for (let e = START_EPOCH; e <= nowEpoch; e++) {
    const ts = epochToUnix(e);
    if (ts < firstTs - 3 * 86400) continue;
    const lp = priceAt(series, ts), sp = priceAt(sol, ts);
    if (lp && sp > 0) { const r = lp / sp; if (r > 0.9 && r < 6) { m[String(e)] = Math.round(r * 1e6) / 1e6; filled++; } }
  }
  console.error(`  ${l.symbol}: ${filled} epochs (from ~epoch ${Math.max(START_EPOCH, Object.keys(m).map(Number).sort((a, b) => a - b)[0] || nowEpoch)})`);
}

writeFileSync(FILE, JSON.stringify({ schemaVersion: 2, note: 'per-LST exact SOL/token rate by epoch — backfilled from DefiLlama (rate = LST_usd / SOL_usd); extended forward once/epoch by record-rates.js', rates }) + '\n');
console.log(`backfilled ${lsts.length} LST(s); history now covers ${Object.keys(rates).length} symbols`);
