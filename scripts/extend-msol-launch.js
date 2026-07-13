#!/usr/bin/env node
// Extend mSOL's rate history back to launch. The general backfill (backfill-rates.js)
// settles mSOL at ~epoch 260 (Dec 2021) because DefiLlama's 2021 coverage is intermittent,
// so the clean interpolation start lands there. But mSOL launched ~Aug 2021 (epoch ~206) at
// an exchange rate of exactly 1.0 SOL, and DefiLlama does have (sparse) real points before
// 260. This one-shot densely samples launch..260, keeps every valid rate = mSOL_usd/SOL_usd,
// pins a launch anchor (rate 1.0), interpolates the gaps, and MERGES into lib/lst-rate-history.json
// without touching the existing 260+ data. mSOL only — other majors launched later.
import '../lib/bootstrap.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '../lib/rpc.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'lib', 'lst-rate-history.json');
const WSOL = 'So11111111111111111111111111111111111111112';
const MSOL = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const SPE = 432_000;
const LAUNCH_EPOCH = 206; // Marinade mainnet mSOL launch ~Aug 2 2021; rate == 1.0 by definition
const END_EPOCH = 262;    // overlap the existing history slightly, then hand off to it

async function blockTimeNear(slot) {
  for (let d = 0; d <= 4000; d += 250) for (const s of [slot + d, slot - d]) {
    if (s < 0) continue;
    const r = await rpc('getBlockTime', [s]).catch(() => null);
    if (typeof r === 'number') return r;
  }
  return null;
}
// epoch→unix anchors around the launch window
const anchors = [];
for (let e = LAUNCH_EPOCH; e <= END_EPOCH + 20; e += 10) { const t = await blockTimeNear(e * SPE); if (t) anchors.push({ e, t }); }
const epochToUnix = (e) => {
  let a = anchors[0], b = anchors[1];
  for (let i = 1; i < anchors.length; i++) { a = anchors[i - 1]; b = anchors[i]; if (e <= anchors[i].e) break; }
  return a.t + (e - a.e) * (b.t - a.t) / (b.e - a.e);
};

// dense per-epoch sampling of real DefiLlama points
const samples = [{ e: LAUNCH_EPOCH, rate: 1.0 }]; // definitional launch anchor
for (let e = LAUNCH_EPOCH + 1; e <= END_EPOCH; e++) {
  const ts = Math.round(epochToUnix(e));
  const r = await fetch(`https://coins.llama.fi/prices/historical/${ts}/solana:${WSOL},solana:${MSOL}`)
    .then((x) => x.ok ? x.json() : null).catch(() => null);
  const sol = r?.coins?.[`solana:${WSOL}`]?.price;
  const ms = r?.coins?.[`solana:${MSOL}`]?.price;
  if (sol > 0 && ms > 0) {
    const rate = ms / sol;
    if (rate >= 0.98 && rate < 1.15) { samples.push({ e, rate }); process.stderr.write('.'); continue; } // sane launch-era band
  }
  process.stderr.write('x');
}
process.stderr.write('\n');

samples.sort((a, b) => a.e - b.e);
console.error(`  real+anchor samples ${LAUNCH_EPOCH}..${END_EPOCH}: ${samples.length}`);
console.error('  ' + samples.map((s) => `${s.e}:${s.rate.toFixed(4)}`).join(' '));

const hist = JSON.parse(readFileSync(FILE, 'utf8'));
const m = hist.rates.mSOL;
const existingStart = Math.min(...Object.keys(m).map(Number));
console.error(`  existing mSOL history starts at epoch ${existingStart}`);

// interpolate launch..(existingStart-1) from the samples; never overwrite existing epochs
let added = 0;
for (let e = LAUNCH_EPOCH; e < existingStart; e++) {
  let i = 0; while (i < samples.length - 1 && samples[i + 1].e <= e) i++;
  const rate = e <= samples[0].e ? samples[0].rate
    : e >= samples[samples.length - 1].e ? samples[samples.length - 1].rate
    : samples[i].rate + (samples[i + 1].rate - samples[i].rate) * (e - samples[i].e) / (samples[i + 1].e - samples[i].e);
  m[String(e)] = Math.round(rate * 1e6) / 1e6;
  added++;
}
hist.note = 'per-LST exact SOL/token rate by epoch — backfilled from DefiLlama historical prices (rate = LST_usd / SOL_usd, sampled+interpolated); mSOL extended to launch (epoch ' + LAUNCH_EPOCH + ', rate 1.0); extended forward once/epoch by record-rates.js';
writeFileSync(FILE, JSON.stringify(hist) + '\n');
const eps = Object.keys(m).map(Number).sort((a, b) => a - b);
console.log(`mSOL extended: +${added} epochs; now ${eps.length} epochs ${eps[0]}..${eps[eps.length - 1]}`);
