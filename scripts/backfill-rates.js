#!/usr/bin/env node
// Backfill exact historical per-LST SOL rates into lib/lst-rate-history.json (schema v2,
// symbol-major) from DefiLlama point-in-time prices: rate(e) = LST_usd(t_e) / SOL_usd(t_e).
// Uses /prices/historical (broader coverage than /chart — includes JupSOL, BNSOL, …),
// sampled every ~STEP epochs (batched across all mints) then linearly interpolated to
// every epoch (LST rates are smooth). Epoch→unix via archival getBlockTime anchors.
// One-shot/retroactive; record-rates.js extends it forward. Args = symbols to limit.
import '../lib/bootstrap.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '../lib/rpc.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'lib', 'lst-rate-history.json');
const REG = JSON.parse(readFileSync(path.join(ROOT, 'lib', 'lst-mints.json'), 'utf8'));
const WSOL = 'So11111111111111111111111111111111111111112';
const SPE = 432_000, START_EPOCH = 200, SAMPLES = 80;

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

// sample epochs across history
const step = Math.max(1, Math.round((nowEpoch - START_EPOCH) / SAMPLES));
const sampleEpochs = []; for (let e = START_EPOCH; e < nowEpoch; e += step) sampleEpochs.push(e); sampleEpochs.push(nowEpoch);

// mint chunks (batch many mints per /prices/historical call; wSOL in every chunk)
const chunks = [];
const mints = lsts.map((l) => l.mint);
for (let i = 0; i < mints.length; i += 24) chunks.push([WSOL, ...mints.slice(i, i + 24)]);

const sampleRates = {}; for (const l of lsts) sampleRates[l.symbol] = []; // sym → [{e, rate}]
const symOf = new Map(lsts.map((l) => [l.mint, l.symbol]));
for (const e of sampleEpochs) {
  const ts = Math.round(epochToUnix(e));
  const priceByMint = {};
  const parts = await Promise.all(chunks.map((chunk) =>
    fetch(`https://coins.llama.fi/prices/historical/${ts}/${chunk.map((m) => 'solana:' + m).join(',')}`)
      .then((r) => r.ok ? r.json() : null).catch(() => null)));
  for (const p of parts) for (const [k, v] of Object.entries(p?.coins || {})) priceByMint[k.replace('solana:', '')] = v.price;
  const sol = priceByMint[WSOL];
  if (!(sol > 0)) { process.stderr.write('x'); continue; }
  for (const l of lsts) { const pr = priceByMint[l.mint]; if (pr > 0) { const rate = pr / sol; if (rate > 0.9 && rate < 6) sampleRates[l.symbol].push({ e, rate }); } }
  process.stderr.write('.');
}
process.stderr.write('\n');

// interpolate samples → every epoch
const hist = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const rates = hist.schemaVersion === 2 && hist.rates ? hist.rates : {};
let covered = 0;
for (const l of lsts) {
  const s = sampleRates[l.symbol].sort((a, b) => a.e - b.e);
  if (s.length < 2) { console.error(`  insufficient DefiLlama data: ${l.symbol} (${s.length} samples)`); continue; }
  const m = rates[l.symbol] || (rates[l.symbol] = {});
  for (let e = s[0].e; e <= nowEpoch; e++) {
    let i = 0; while (i < s.length - 1 && s[i + 1].e <= e) i++;
    const rate = e <= s[0].e ? s[0].rate : e >= s[s.length - 1].e ? s[s.length - 1].rate
      : s[i].rate + (s[i + 1].rate - s[i].rate) * (e - s[i].e) / (s[i + 1].e - s[i].e);
    m[String(e)] = Math.round(rate * 1e6) / 1e6;
  }
  covered++;
  console.error(`  ${l.symbol}: ${s.length} samples → epochs ${s[0].e}..${nowEpoch}`);
}
writeFileSync(FILE, JSON.stringify({ schemaVersion: 2, note: 'per-LST exact SOL/token rate by epoch — backfilled from DefiLlama historical prices (rate = LST_usd / SOL_usd, sampled+interpolated); extended forward once/epoch by record-rates.js', rates }) + '\n');
console.log(`backfilled ${covered}/${lsts.length} LSTs; history covers ${Object.keys(rates).length} symbols`);
