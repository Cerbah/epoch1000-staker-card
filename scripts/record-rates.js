#!/usr/bin/env node
// Trusted rate recorder — run ONCE PER EPOCH (cron), independent of user requests.
// Appends the exact current per-LST exchange rate (Sanctum sol-value + Marinade mSOL) to
// lib/lst-rate-history.json, keyed by epoch. Builds an exact rate history going FORWARD;
// retroactive reconstruction is infeasible (LST pools do ~33k txs/epoch). Idempotent: a
// re-run in the same epoch just refreshes that epoch's entry.
import '../lib/bootstrap.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from '../lib/rpc.js';
import { currentRates } from '../lib/lst.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'lst-rate-history.json');
const epoch = String((await rpc('getEpochInfo')).epoch);
const rates = await currentRates();
const hist = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const out = { schemaVersion: 2, note: 'per-LST exact SOL/token rate by epoch — backfilled from DefiLlama (rate = LST_usd / SOL_usd); extended forward once/epoch by record-rates.js', rates: (hist.schemaVersion === 2 && hist.rates) || {} };
let n = 0;
for (const [sym, r] of Object.entries(rates)) {
  if (!(r > 0)) continue;
  (out.rates[sym] = out.rates[sym] || {})[epoch] = Math.round(r * 1e6) / 1e6;
  n++;
}
writeFileSync(FILE, JSON.stringify(out) + '\n');
console.log(`recorded epoch ${epoch}: ${n} LST rates; history covers ${Object.keys(out.rates).length} symbols`);
