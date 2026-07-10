// "Fully staked" benchmark: Marinade mSOL rolling APY (per user decision 2026-07-10 —
// the counterfactual is "held mSOL from day one", not SSR/network average).
// Shape: {times[],values[],labels[]}, values are decimal fractions, ~1 point per 2 days.
// Token name in the path is case-sensitive (mSOL). Fallback: constant 7%.

const FALLBACK_APY = 0.07;
const EPOCHS_PER_YEAR = 160; // ~2.28-day epochs

let cached = null;

export async function benchmark() {
  if (cached) return cached;
  let apy = FALLBACK_APY;
  let source = 'fallback constant 7%';
  let series = null; // {times[], values[]} for future per-epoch benchmark refinement
  try {
    const r = await fetch('https://apy.marinade.finance/v1/rolling-apy/liquid-token/mSOL');
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j?.values) && j.values.length) {
        apy = j.values[j.values.length - 1];
        series = { times: j.times, values: j.values };
        source = 'apy.marinade.finance /v1/rolling-apy/liquid-token/mSOL';
      }
    }
  } catch { /* fallback */ }
  const perEpoch = Math.pow(1 + apy, 1 / EPOCHS_PER_YEAR) - 1;
  // APY at a unix timestamp from the historical series (clamped at both ends).
  const apyAt = (unix) => {
    if (!series) return apy;
    const { times, values } = series;
    if (unix <= times[0]) return values[0];
    if (unix >= times[times.length - 1]) return values[values.length - 1];
    let lo = 0, hi = times.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (times[mid] <= unix) lo = mid; else hi = mid; }
    return values[lo];
  };
  const perEpochAt = (unix) => Math.pow(1 + apyAt(unix), 1 / EPOCHS_PER_YEAR) - 1;
  cached = { apy, perEpoch, source, series, apyAt, perEpochAt };
  return cached;
}
