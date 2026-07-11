// epoch1000 staker card — static browser build (GitHub Pages, no server).
// The whole pipeline runs client-side: Helius RPC + Enhanced API, Marinade
// staking-rewards / APY APIs, Sanctum rates (all CORS-open, verified 2026-07-10).
// The Helius key below is intentionally public (team decision).
'use strict';
const HELIUS_KEY = 'e794285b-a195-4ebc-9918-5bda20d38db6';

/* -- rpc -- */
// Helius JSON-RPC + Enhanced API helpers.
// SOLANA_RPC_URL and HELIUS_API_KEY come from the environment (persistent sandbox env).

// Read lazily so the .env bootstrap (loaded first by server.js) is honored.
const RPC_URL = () => 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;


let rpcId = 0;

async function rpc(method, params, { retries = 2 } = {}) {
  if (!RPC_URL()) throw new Error('SOLANA_RPC_URL or HELIUS_API_KEY must be set (env or .env file)');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const body = await res.json().catch(() => null);
    if (body && body.result !== undefined) return body.result;
    const err = body?.error?.message || `HTTP ${res.status}`;
    if (attempt >= retries) throw new Error(`${method}: ${err}`);
    await sleep(400 * (attempt + 1)); // back off on rate limits
  }
}

// Parsed transactions, 100 signatures per call, chunks fetched in parallel.
async function enhancedTransactions(signatures, { concurrency = 4 } = {}) {
  const chunks = [];
  for (let i = 0; i < signatures.length; i += 100) chunks.push(signatures.slice(i, i + 100));
  const out = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      const my = next++;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactions: chunks[my] }),
        });
        if (res.ok) { out[my] = await res.json(); break; }
        if (attempt >= 2) throw new Error(`enhanced tx API: HTTP ${res.status}`);
        await sleep(500 * (attempt + 1));
      }
    }
  }));
  return out.flat();
}

// Full signature history (newest first), capped.
async function signaturesForAddress(address, { maxPages = 5 } = {}) {
  const sigs = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc('getSignaturesForAddress', [address, { limit: 1000, ...(before && { before }) }]);
    sigs.push(...batch);
    if (batch.length < 1000) return { sigs, truncated: false };
    before = batch[batch.length - 1].signature;
  }
  return { sigs, truncated: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -- lst -- */
// Major Sanctum LSTs (TVL ≥ ~1,300 SOL ≈ $100k at snapshot time) + every LST held by
// known test wallets. Registry generated 2026-07-10 from igneous-labs/sanctum-lst-list
// with live Sanctum sol-value rates baked as fallbacks — regenerate via README note.
// Current rates: Sanctum sol-value (chunked); Marinade API overrides mSOL.
// Historical rates are back-compounded from the current rate at the benchmark yield.





let REGISTRY = [];
let LST_MINTS = {};
let FALLBACK_RATES = {};
async function ensureRegistry() {
  if (REGISTRY.length) return;
  REGISTRY = await (await fetch('./lst-mints.json')).json();
  LST_MINTS = Object.fromEntries(REGISTRY.map((l) => [l.mint, { symbol: l.symbol, decimals: l.decimals }]));
  FALLBACK_RATES = Object.fromEntries(REGISTRY.map((l) => [l.symbol, l.fallbackRate]));
}



let ratesCache = null;

async function currentRates() {
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
function rateAtEpoch(currentRate, perEpochYield, nowEpoch, e) {
  return currentRate / Math.pow(1 + perEpochYield, Math.max(0, nowEpoch - e));
}

/* -- benchmark -- */
// "Fully staked" benchmark: Marinade mSOL rolling APY (per user decision 2026-07-10 —
// the counterfactual is "held mSOL from day one", not SSR/network average).
// Shape: {times[],values[],labels[]}, values are decimal fractions, ~1 point per 2 days.
// Token name in the path is case-sensitive (mSOL). Fallback: constant 7%.

const FALLBACK_APY = 0.07;
const EPOCHS_PER_YEAR = 160; // ~2.28-day epochs

let cached = null;

async function benchmark() {
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

/* -- marinade -- */
// Marinade staking-rewards API (step 1 primary path).
// Verified flow: GET /v1/status?withdraw=<W> → status Missing|Processing|Ready|Error.
// When Ready, GET /v1/report?withdraw=<W>&stake=<S> (both params required — one call
// per distinct stake authority) returns slot-by-slot ReportTxRecords with full
// merge/split lineage: deposit / withdraw / profit {inflation_reward, mev_reward,
// voting_reward, marinade_settlement, ...} / loss — lamports as strings.
// /v1/csv-report-cache needs server-side report configuration — not usable generically.
// We never auto-trigger crawls (POST /v1/crawl) from the PoC.

const BASE = 'https://staking-rewards-api.marinade.finance';
const SLOTS_PER_EPOCH = 432_000;
const LAMPORTS = 1e9;

async function crawlStatus(wallet) {
  try {
    const r = await fetch(`${BASE}/v1/status?withdraw=${wallet}`);
    if (!r.ok) return { status: 'Unknown', http: r.status };
    return await r.json(); // { withdraw, status, done_time, to_slot, ... }
  } catch (e) {
    return { status: 'Unreachable', error: String(e) };
  }
}

async function report(withdraw, stake) {
  const r = await fetch(`${BASE}/v1/report?withdraw=${withdraw}&stake=${stake}`);
  if (!r.ok) throw new Error(`/v1/report(${stake.slice(0, 6)}…) HTTP ${r.status}`);
  return await r.json(); // { data: [{ slot, block_time, txs: [{ tx_sig, profit?, deposit?, withdraw?, loss? }] }] }
}

// Merge one or more /v1/report payloads into an epoch-ordered ledger:
//   entries: [{epoch, deposit, withdraw, rewards}]  (SOL, per epoch)
//   cum:     [{epoch, rewards, principal}]          (SOL, cumulative)
function buildLedger(reports) {
  const byEpoch = new Map();
  const bucket = (ep) => {
    if (!byEpoch.has(ep)) byEpoch.set(ep, { epoch: ep, deposit: 0, withdraw: 0, rewards: 0 });
    return byEpoch.get(ep);
  };
  for (const rep of reports) {
    for (const row of rep?.data ?? []) {
      const epoch = Math.floor(Number(row.slot) / SLOTS_PER_EPOCH);
      for (const tx of row.txs ?? []) {
        const dep = num(tx.deposit?.deposit), wd = num(tx.withdraw?.withdraw);
        if (dep || wd) { const e = bucket(epoch); e.deposit += dep; e.withdraw += wd; }
        let rew = 0;
        for (const v of Object.values(tx.profit ?? {})) rew += num(v);
        for (const v of Object.values(tx.loss ?? {})) rew -= num(v);
        // rewards are paid in the first slots of the NEXT epoch — attribute to the epoch they were earned
        // (verified: ledger tx at epoch-1000 slots == chain getInflationReward for epoch 999, to the lamport)
        if (rew) bucket(epoch - 1).rewards += rew;
      }
    }
  }
  const entries = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  const cum = [];
  let rewards = 0, principal = 0;
  for (const e of entries) {
    rewards += e.rewards;
    principal += e.deposit - e.withdraw; // raw net flows — negative when withdrawn rewards exceed deposits; stake balance = principal + rewards
    cum.push({ epoch: e.epoch, rewards, principal });
  }
  return {
    entries,
    cum,
    totalRewards: rewards,
    firstDepositEpoch: entries.find((e) => e.deposit > 0)?.epoch ?? null,
    // cumulative rewards / principal at epoch e (last known value ≤ e)
    at(e) {
      let lo = 0, hi = cum.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid].epoch <= e) { best = cum[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return best ?? { epoch: e, rewards: 0, principal: 0 };
    },
  };
}

const num = (v) => (v === undefined || v === null ? 0 : Number(v) / LAMPORTS);

/* -- pipeline -- */
// Builds the full staking-performance report for a wallet.
//
// Series (SOL, on a shared sampled epoch grid):
//   you(e)  = wallet SOL + stake balance + LST value            (reconstructed reality)
//   hold(e) = you(e) − cumulative staking rewards               (counterfactual: never staked)
//   full(e) = hold's net deposits compounding at mSOL APY       (counterfactual: all-in from day one)
//   mnde(e) = you(e) with the native-staking reward stream      (counterfactual: same behavior,
//             replaced by mSOL-APY yield on your staked principal — "Marinade ran my staking")
//
// Native rewards source: Marinade staking-rewards /v1/report when the wallet is crawled
// (full merge/split lineage incl. MEV & PSR) — else sampled archival getInflationReward.






const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
// Throughput knobs — defaults sized for a paid Helius plan (2026-07-10 upgrade).
const MAX_SIG_PAGES = 10;         // ×1000 sigs history cap
const MAX_ENHANCED_TX = 4000;   // parsed-tx replay budget
const REWARD_SAMPLE_CALLS = 40;
const REWARD_CONCURRENCY = 8; // parallel getInflationReward calls

async function buildReport(wallet) {
  const notes = [];
  const [epochInfo, bench, rates] = await Promise.all([rpc('getEpochInfo'), benchmark(), currentRates()]);
  const nowEpoch = epochInfo.epoch;

  // ── stake accounts (current) ───────────────────────────────────────────────
  const stakeAccounts = await rpc('getProgramAccounts', [STAKE_PROGRAM, {
    encoding: 'jsonParsed',
    filters: [
      { dataSize: 200 },
      { memcmp: { offset: 44, bytes: wallet } }, // withdraw authority
    ],
  }]);
  const stakes = stakeAccounts.map((a) => {
    const info = a.account.data.parsed?.info;
    const d = info?.stake?.delegation;
    return {
      address: a.pubkey,
      lamports: a.account.lamports,
      staker: info?.meta?.authorized?.staker ?? wallet,
      voter: d?.voter ?? null,
      activationEpoch: d ? Number(d.activationEpoch) : null,
    };
  });
  const activeStakes = stakes.filter((s) => s.activationEpoch !== null);
  const stakeNowSol = stakes.reduce((t, s) => t + s.lamports, 0) / LAMPORTS;
  let firstStakeEpoch = activeStakes.length ? Math.min(...activeStakes.map((s) => s.activationEpoch)) : null;

  // ── native rewards: Marinade lineage report, else sampled getInflationReward ──
  const marinade = await crawlStatus(wallet);
  let ledger = null;
  if (marinade?.status === 'Ready') {
    // one /v1/report per distinct stake authority (Marinade Native uses staker PDAs,
    // self-managed stake usually staker = wallet — query wallet too in case all accounts were closed)
    const stakers = [...new Set([...stakes.map((s) => s.staker), wallet])];
    const reports = [];
    for (const s of stakers) {
      try { reports.push(await report(wallet, s)); }
      catch (err) { notes.push(`marinade report ${err.message}`); }
    }
    const l = buildLedger(reports);
    if (l.cum.length) {
      ledger = l;
      notes.push(`rewards from Marinade staking-rewards report — full merge/split lineage incl. MEV & PSR (${l.entries.length} reward epochs, ${stakers.length} stake authorities)`);
      if (l.firstDepositEpoch !== null) firstStakeEpoch = firstStakeEpoch === null ? l.firstDepositEpoch : Math.min(firstStakeEpoch, l.firstDepositEpoch);
    } else {
      notes.push('marinade crawl Ready but report empty — falling back to sampled rewards');
    }
  }

  const rewardSamples = []; // {epoch, span, perAcct[]} — perAcct aligned with activeStakes order
  if (!ledger && activeStakes.length) {
    const from = Math.max(1, Math.min(...activeStakes.map((s) => s.activationEpoch)) + 1);
    const step = Math.max(1, Math.ceil((nowEpoch - from) / REWARD_SAMPLE_CALLS));
    const addrs = activeStakes.map((s) => s.address);
    const epochs = [];
    for (let e = from; e < nowEpoch; e += step) epochs.push(e);
    await pool(epochs, REWARD_CONCURRENCY, async (e) => {
      try {
        const res = await rpc('getInflationReward', [addrs, { epoch: e }]);
        rewardSamples.push({ epoch: e, span: Math.min(step, nowEpoch - e), perAcct: res.map((r) => (r?.amount ?? 0) / LAMPORTS) });
      } catch (err) {
        notes.push(`rewards sample @${e} failed: ${err.message}`);
      }
    });
    rewardSamples.sort((a, b) => a.epoch - b.epoch);
    notes.push('rewards sampled on current stake accounts only — pre-merge/split lineage not traced'
      + (marinade?.status === 'Processing' ? ' (Marinade crawl in progress — recheck later for full lineage)' : ''));
  }
  const cumRewAcct = (e, i) => rewardSamples.reduce((t, s) => (s.epoch <= e ? t + s.perAcct[i] * Math.min(s.span, e - s.epoch + 1) : t), 0);
  const cumRewAt = ledger
    ? (e) => ledger.at(e).rewards
    : (e) => rewardSamples.reduce((t, s) => (s.epoch <= e ? t + s.perAcct.reduce((a, b) => a + b, 0) * Math.min(s.span, e - s.epoch + 1) : t), 0);
  const totalStakeRewards = ledger ? ledger.totalRewards : cumRewAt(nowEpoch);

  // ── wallet SOL + LST balance timelines via parsed-tx replay ────────────────
  const balanceNow = (await rpc('getBalance', [wallet])).value / LAMPORTS;
  const lstNow = {};
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const tokenAccs = await rpc('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed' }]);
    for (const ta of tokenAccs.value) {
      const info = ta.account.data.parsed.info;
      const meta = LST_MINTS[info.mint];
      if (meta) lstNow[meta.symbol] = (lstNow[meta.symbol] ?? 0) + Number(info.tokenAmount.uiAmount ?? 0);
    }
  }

  const { sigs, truncated } = await signaturesForAddress(wallet, { maxPages: MAX_SIG_PAGES });
  if (truncated) notes.push(`history truncated to most recent ${sigs.length} signatures — older activity approximated`);
  const okSigs = sigs.filter((s) => !s.err);
  const replaySigs = okSigs.slice(0, MAX_ENHANCED_TX);
  if (okSigs.length > replaySigs.length) notes.push(`replayed newest ${replaySigs.length} of ${okSigs.length} txs`);

  let events = [];
  try {
    const txs = await enhancedTransactions(replaySigs.map((s) => s.signature));
    const bySig = new Map(txs.filter(Boolean).map((t) => [t.signature, t]));
    events = replaySigs.map((s) => {
      const t = bySig.get(s.signature);
      if (!t) return null;
      const acc = (t.accountData ?? []).find((a) => a.account === wallet);
      const lstDelta = {};
      for (const a of t.accountData ?? []) {
        for (const c of a.tokenBalanceChanges ?? []) {
          const meta = LST_MINTS[c.mint];
          if (meta && c.userAccount === wallet) {
            lstDelta[meta.symbol] = (lstDelta[meta.symbol] ?? 0) + Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals;
          }
        }
      }
      return { epoch: Math.floor(s.slot / SLOTS_PER_EPOCH), solDelta: (acc?.nativeBalanceChange ?? 0) / LAMPORTS, lstDelta };
    }).filter(Boolean);
  } catch (err) {
    notes.push(`enhanced-tx replay unavailable (${err.message}) — wallet balance held flat`);
  }

  const firstSeenEpoch = events.length ? events[events.length - 1].epoch : (firstStakeEpoch ?? nowEpoch - 1);
  const startEpoch = Math.min(firstSeenEpoch, firstStakeEpoch ?? firstSeenEpoch);
  const step = Math.max(1, Math.ceil((nowEpoch - startEpoch) / 120));
  const grid = [];
  for (let e = startEpoch; e <= nowEpoch; e += step) grid.push(e);
  if (grid[grid.length - 1] !== nowEpoch) grid.push(nowEpoch);

  const walletAt = new Map(), lstAt = new Map();
  { // reconstruct point-in-time wallet SOL + LST balances at each grid epoch (events newest → oldest)
    let sol = balanceNow;
    const lst = { ...lstNow };
    let gi = grid.length - 1;
    walletAt.set(nowEpoch, sol); lstAt.set(nowEpoch, { ...lst });
    for (const ev of events) {
      while (gi > 0 && grid[gi - 1] >= ev.epoch) { gi--; walletAt.set(grid[gi], sol); lstAt.set(grid[gi], { ...lst }); }
      sol -= ev.solDelta;
      for (const [sym, d] of Object.entries(ev.lstDelta)) lst[sym] = (lst[sym] ?? 0) - d;
    }
    while (gi > 0) { gi--; walletAt.set(grid[gi], sol); lstAt.set(grid[gi], { ...lst }); }
  }

  // LSTs count as staking: first LST acquisition sets the first-stake epoch too
  const firstLstEpoch = grid.find((e) => Object.values(lstAt.get(e) ?? {}).some((b) => b > 1e-6)) ?? null;
  if (firstLstEpoch !== null) firstStakeEpoch = firstStakeEpoch === null ? firstLstEpoch : Math.min(firstStakeEpoch, firstLstEpoch);

  // ── compose series ─────────────────────────────────────────────────────────
  // Historical stake = per-account current balance minus that account's own post-e
  // rewards; accounts not yet active at e contribute nothing. (Per-account netting —
  // the aggregate version double-subtracted later accounts' rewards and inflated APY.)
  const stakeAtSampled = (e) => Math.max(0, activeStakes.reduce((t, s, i) =>
    s.activationEpoch <= e ? t + s.lamports / LAMPORTS - (cumRewAcct(nowEpoch, i) - cumRewAcct(e, i)) : t, 0));
  // Ledger stake balance = net flows + rewards, anchored to the on-chain balance now
  // (crawl lags the chain tip; the anchor absorbs post-crawl flows/rewards as a constant).
  let stakeAt = stakeAtSampled;
  if (ledger) {
    const end = ledger.at(nowEpoch);
    const anchor = stakeNowSol - (end.principal + end.rewards);
    // apply from the crawl boundary only, so post-crawl deposits register as flows, not as rewritten history
    const anchorEpoch = ledger.cum.length ? ledger.cum[ledger.cum.length - 1].epoch : nowEpoch;
    if (Math.abs(anchor) > 0.01) notes.push(`ledger anchored to on-chain stake balance (${anchor > 0 ? '+' : ''}${anchor.toFixed(2)} SOL post-crawl adjustment from epoch ${anchorEpoch})`);
    stakeAt = (e) => Math.max(0, ledger.at(e).principal + ledger.at(e).rewards + (e >= anchorEpoch ? anchor : 0));
  }

  const lstValueAt = (e, useRate) => Object.entries(lstAt.get(e) ?? {})
    .reduce((t, [sym, bal]) => t + Math.max(0, bal) * (useRate ? rateAtEpoch(rates[sym] ?? 1, bench.perEpoch, nowEpoch, e) : 1), 0);
  // LST yield accrues on the balance actually held while it was held (rate growth ×
  // holding), so the exchange-rate premium at acquisition is cost basis, not "earned".
  const lstApprCum = [];
  { let acc = 0;
    for (let i = 0; i < grid.length; i++) {
      if (i > 0) {
        for (const [sym, bal] of Object.entries(lstAt.get(grid[i - 1]) ?? {})) {
          if (bal > 0) acc += bal * (rateAtEpoch(rates[sym] ?? 1, bench.perEpoch, nowEpoch, grid[i])
                                   - rateAtEpoch(rates[sym] ?? 1, bench.perEpoch, nowEpoch, grid[i - 1]));
        }
      }
      lstApprCum.push(acc);
    }
  }

  // All series share one baseline: the wallet's actual balance net of all staking
  // rewards ("never staked" — deposits/withdrawals only). Each line adds its own
  // CUMULATIVE reward stream on top, kept forever — a withdrawal moves the baseline,
  // it never erases rewards already earned. So "you" always ends at baseline + earned,
  // matching the card, even when the wallet moved funds out.
  const balTraj = grid.map((e) => Math.max(0, (walletAt.get(e) ?? 0)) + stakeAt(e) + lstValueAt(e, true));
  const hold = balTraj.map((b, i) => Math.max(0, b - cumRewAt(grid[i]) - lstApprCum[i]));
  const you = hold.map((h, i) => h + Math.max(0, cumRewAt(grid[i])) + lstApprCum[i]);

  // Counterfactual lines = actual balance trajectory + a hypothetical reward pot.
  // The pot accrues each step on the balance the wallet actually had (time-averaged
  // exposure × mSOL yield) and is KEPT — real withdrawals move principal, never the pot.
  //   full: yield on ALL holdings (hold trajectory)      → "all-in from day one"
  //   mnde: yield on what was actually staked (stakeAt)  → "Marinade ran my staking"
  const EPOCH_SEC = 197_000; // ~2.28 days
  const nowSec = Date.now() / 1000;
  const epochUnix = (e) => nowSec - (nowEpoch - e) * EPOCH_SEC;
  const full = [], mnde = [];
  let fullPot = 0, mndePot = 0;
  for (let i = 0; i < grid.length; i++) {
    if (i > 0) {
      // time-varying benchmark: mSOL APY as it actually was at that point in history
      const g = Math.pow(1 + bench.perEpochAt(epochUnix(grid[i - 1])), grid[i] - grid[i - 1]) - 1;
      fullPot += (hold[i - 1] + fullPot) * g;
      // mnde pot accrues on the whole staked exposure — native stake + LST SOL-value —
      // swapping the entire actual reward stream (native rewards + LST appreciation)
      const actualRew = cumRewAt(grid[i - 1]) + lstApprCum[i - 1];
      mndePot += Math.max(0, stakeAt(grid[i - 1]) + lstValueAt(grid[i - 1], true) - (actualRew - mndePot)) * g;
    }
    full.push(hold[i] + fullPot);
    mnde.push(hold[i] + mndePot);
  }

  // sanity invariants — violations are surfaced, never silently shipped
  for (let i = 0; i < grid.length; i++) {
    if (full[i] < hold[i] - 1e-6 || mnde[i] < hold[i] - 1e-6 || you[i] < hold[i] - 1e-6) {
      notes.push(`INVARIANT VIOLATION at epoch ${grid[i]} — hold/you/mnde/full ordering broken, treat this report with suspicion`);
      break;
    }
  }

  const earned = totalStakeRewards + lstApprCum[lstApprCum.length - 1];
  const endYou = you[you.length - 1], endHold = hold[hold.length - 1], endFull = full[full.length - 1];
  const potential = fullPot;
  const stakedSpan = grid.filter((e) => e >= (firstStakeEpoch ?? startEpoch));
  const avgStaked = stakedSpan.length // LSTs at SOL value — same denomination as `earned`
    ? stakedSpan.reduce((t, e) => t + stakeAt(e) + lstValueAt(e, true), 0) / stakedSpan.length : 0;
  const yearsSpan = (nowEpoch - (firstStakeEpoch ?? startEpoch)) / 160;
  const effApy = avgStaked > 0 && yearsSpan > 0.01 ? Math.pow(1 + earned / avgStaked, 1 / yearsSpan) - 1 : 0;
  // Total APY: same rewards, but relative to ALL SOL held (staked + idle) over the
  // holding span — denominator is the actual balance trajectory (rewards included,
  // like the staked-APY denominator), so an all-in wallet reads total ≈ staked.
  const holdSpan = grid.map((e, i) => ({ e, h: balTraj[i] })).filter((x) => x.h > 1e-6);
  const avgHold = holdSpan.length ? holdSpan.reduce((t, x) => t + x.h, 0) / holdSpan.length : 0;
  const yearsHold = holdSpan.length ? Math.max(0.01, (nowEpoch - holdSpan[0].e) / 160) : 0;
  const totalApy = avgHold > 0 && yearsHold > 0.01 ? Math.min(effApy, Math.pow(1 + earned / avgHold, 1 / yearsHold) - 1) : 0;

  return {
    wallet,
    generatedAt: new Date().toISOString(),
    current: { epoch: nowEpoch },
    series: { eps: grid, hold: rnd(hold), you: rnd(you), full: rnd(full), mnde: rnd(mnde) },
    card: {
      earnedSol: r4(earned),
      stakedSol: r4(stakeNowSol + lstValueAt(nowEpoch, true)),
      holdingsSol: r4(balTraj[balTraj.length - 1]), // actual current balance (chart "you" ends at baseline + kept rewards)
      avgStakedSol: r4(avgStaked),
      firstStakeEpoch,
      epochsStaked: firstStakeEpoch !== null ? nowEpoch - firstStakeEpoch : 0,
      effApy: r4(effApy),
      totalApy: r4(totalApy),
      efficiency: potential > 0 ? r4(Math.min(1, Math.max(0, earned / potential))) : 0,
      missedSol: r4(Math.max(0, fullPot - earned)),      // rewards gap vs all-in-from-day-one
      mndeRewardsSol: r4(mndePot),                 // what Marinade would have yielded on your staked exposure (native + LST)
      mndeDeltaSol: r4(mndePot - earned),          // >0: Marinade beats your actual reward stream
    },
    meta: {
      version: 'poc-0.7.0', // bumped on any math/semantics change so number shifts are attributable
      benchmark: bench,
      marinadeCrawl: marinade?.status ?? 'Unknown',
      rewardsSource: ledger ? 'marinade-report' : 'helius-sampled',
      stakeAccounts: stakes.length,
      lstPositions: lstNow,
      sigCount: sigs.length,
      truncated,
      notes,
    },
  };
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const rnd = (a) => a.map(r4);


/* ---- browser wrapper: localStorage cache + globals ---- */
const CACHE_TTL_MS = 6 * 3600 * 1000;
window.buildReportLive = async function (wallet) {
  try {
    const hit = JSON.parse(localStorage.getItem('e1k:' + wallet) || 'null');
    if (hit && Date.now() - Date.parse(hit.generatedAt) < CACHE_TTL_MS) { hit.meta.cache = 'hit'; return hit; }
  } catch (_) {}
  await ensureRegistry();
  const r = await buildReport(wallet);
  try { localStorage.setItem('e1k:' + wallet, JSON.stringify(r)); } catch (_) {}
  return r;
};
window.epochInfoLive = () => rpc('getEpochInfo');
