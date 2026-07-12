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
const epoch = (await rpc('getEpochInfo')).epoch;
const rates = await currentRates();
const hist = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { schemaVersion: 1, note: 'exact per-LST SOL/token rate recorded once per epoch (trusted data); epochs before the first entry fall back to benchmark back-compounding', epochs: {} };
hist.epochs[String(epoch)] = Object.fromEntries(
  Object.entries(rates).filter(([, r]) => r > 0).map(([s, r]) => [s, Math.round(r * 1e9) / 1e9]));
writeFileSync(FILE, JSON.stringify(hist, null, 0) + '\n');
console.log(`recorded epoch ${epoch}: ${Object.keys(hist.epochs[String(epoch)]).length} LST rates; history now spans ${Object.keys(hist.epochs).length} epoch(s)`);
