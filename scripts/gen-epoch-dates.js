#!/usr/bin/env node
// Generate epoch→unix anchor points from real on-chain block times (getBlockTime), sampled
// every ~12 epochs. Written to lib/epoch-dates.json and inlined into the UI so charts can
// label the x-axis with approximate dates instead of raw epoch numbers. Extend forward
// occasionally (past anchors are fixed). Probes nearby slots when a boundary slot is skipped.
import '../lib/bootstrap.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '../lib/rpc.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'epoch-dates.json');
const SPE = 432_000, FROM = 132, STEP = 12;
const nowEpoch = (await rpc('getEpochInfo')).epoch;

async function blockTimeNear(slot) {
  for (let d = 0; d <= 4000; d += 250) for (const s of [slot + d, slot - d]) {
    if (s < 0) continue;
    const r = await rpc('getBlockTime', [s]).catch(() => null);
    if (typeof r === 'number') return r;
  }
  return null;
}
const anchors = [];
for (let e = FROM; e <= nowEpoch; e += STEP) { const t = await blockTimeNear(e * SPE); if (t) anchors.push([e, t]); }
{ const t = await blockTimeNear(nowEpoch * SPE); if (t && anchors[anchors.length - 1][0] !== nowEpoch) anchors.push([nowEpoch, t]); }

writeFileSync(OUT, JSON.stringify({ note: 'epoch → unix seconds, real getBlockTime anchors (interpolate between)', anchors }) + '\n');
console.log(`wrote ${anchors.length} anchors, epochs ${anchors[0][0]}..${anchors[anchors.length - 1][0]}`);
console.log('sample:', anchors.filter((_, i) => i % 8 === 0).map(([e, t]) => `e${e}=${new Date(t * 1000).toISOString().slice(0, 7)}`).join(' '));
