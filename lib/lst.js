// Major Sanctum LSTs (TVL ≥ ~1,300 SOL ≈ $100k at snapshot time) + every LST held by
// known test wallets. Registry generated 2026-07-10 from igneous-labs/sanctum-lst-list
// with live Sanctum sol-value rates baked as fallbacks — regenerate via README note.
// Current rates: Sanctum sol-value (chunked); Marinade API overrides mSOL.
// Historical rates are back-compounded from the current rate at the benchmark yield.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'lst-mints.json'), 'utf8'));

export const LST_MINTS = Object.fromEntries(
  REGISTRY.map((l) => [l.mint, { symbol: l.symbol, decimals: l.decimals }]));

const FALLBACK_RATES = Object.fromEntries(REGISTRY.map((l) => [l.symbol, l.fallbackRate]));

// Trusted per-epoch exact rate history — recorded once/epoch by scripts/record-rates.js
// (retroactive reconstruction is infeasible: LST pools do ~33k txs/epoch). In the static
// build this object is injected at build time (see build-static.py).
let RATE_HISTORY_EPOCHS = {};
try { RATE_HISTORY_EPOCHS = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lst-rate-history.json'), 'utf8')).epochs || {}; } catch { /* none recorded yet */ }

// Exact recorded SOL/token rate at/before epoch e (rates are ~monotonic; use the most
// recent recorded epoch ≤ e). Returns null when e predates recording → caller falls back
// to benchmark back-compounding.
export function recordedRateAt(sym, e) {
  let best = null, bestEp = -1;
  for (const k in RATE_HISTORY_EPOCHS) {
    const ep = +k, r = RATE_HISTORY_EPOCHS[k][sym];
    if (ep <= e && ep > bestEp && r != null) { best = r; bestEp = ep; }
  }
  return best;
}
export const rateHistorySpan = () => Object.keys(RATE_HISTORY_EPOCHS).length;

let ratesCache = null;

export async function currentRates() {
  if (ratesCache) return ratesCache;
  const rates = { ...FALLBACK_RATES };
  const symbols = [...new Set(REGISTRY.map((l) => l.symbol))];
  for (let i = 0; i < symbols.length; i += 15) {
    try {
      const q = symbols.slice(i, i + 15).map((s) => 'lst=' + s).join('&');
      const r = await fetch('https://extra-api.sanctum.so/v1/sol-value/current?' + q,
        { headers: { 'User-Agent': 'epoch1000-poc/0.6' } });
      if (r.ok) {
        const j = await r.json();
        for (const [sym, lamports] of Object.entries(j?.solValues ?? {})) {
          const v = Number(lamports) / 1e9;
          if (v > 0) rates[sym] = v;
        }
      }
      await new Promise((res) => setTimeout(res, 250));
    } catch { /* keep fallbacks for this chunk */ }
  }
  try {
    // Marinade's own rate is authoritative for mSOL (Sanctum's lags ~1%)
    const r = await fetch('https://api.marinade.finance/msol/price_sol');
    if (r.ok) {
      const v = Number(await r.text());
      if (v > 0) rates.mSOL = v;
    }
  } catch { /* keep Sanctum/fallback value */ }
  ratesCache = rates;
  return rates;
}

// rate at epoch e, back-compounded from current rate at epoch `nowEpoch`
export function rateAtEpoch(currentRate, perEpochYield, nowEpoch, e) {
  return currentRate / Math.pow(1 + perEpochYield, Math.max(0, nowEpoch - e));
}
