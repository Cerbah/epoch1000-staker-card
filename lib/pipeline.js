// Builds the full staking-performance report for a wallet.
//
// Series (SOL, on a shared sampled epoch grid):
//   you(e)  = wallet SOL + stake balance + LST value            (reconstructed reality)
//   hold(e) = you(e) − cumulative staking rewards               (counterfactual: never staked)
//   full(e) = hold's net deposits compounding at mSOL APY       (counterfactual: all-in from day one)
//   mnde(e) = you(e) with the whole reward stream               (counterfactual: same behavior,
//             replaced by mSOL-APY yield on the staked exposure — "Marinade ran my staking")
//
// Attribution model: history is only attributed to the wallet from the moment IT was
// involved — per stake account, from the wallet's first transaction touching that
// account (accounts acquired via authority handoff carry a previous owner's history,
// which is excluded). Native rewards come from Marinade staking-rewards /v1/report when
// crawled (full merge/split lineage incl. MEV & PSR), else sampled getInflationReward.

import { rpc, enhancedTransactions, signaturesForAddress } from './rpc.js';
import { LST_MINTS, currentRates, rateAtEpoch } from './lst.js';
import { benchmark } from './benchmark.js';
import { crawlStatus, report, buildLedger } from './marinade.js';

const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
const SLOTS_PER_EPOCH = 432_000;
const LAMPORTS = 1e9;
// Depth budgets — sized to replay MOST wallets to inception on a paid Helius plan
// ("right first time"); only true monsters get truncated, loudly.
const MAX_SIG_PAGES = Number(process.env.MAX_SIG_PAGES ?? 20);          // ×1000 sigs history cap
const MAX_ENHANCED_TX = Number(process.env.MAX_ENHANCED_TX ?? 20000);   // parsed-tx replay budget
const REWARD_SAMPLE_CALLS = Number(process.env.REWARD_SAMPLE_CALLS ?? 40);
const REWARD_CONCURRENCY = Number(process.env.REWARD_CONCURRENCY ?? 8); // parallel getInflationReward calls

export async function buildReport(wallet) {
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
      activationEpoch: d ? Number(d.activationEpoch) : null,
    };
  });
  const activeStakes = stakes.filter((s) => s.activationEpoch !== null);
  const stakeNowSol = stakes.reduce((t, s) => t + s.lamports, 0) / LAMPORTS;
  let firstStakeEpoch = activeStakes.length ? Math.min(...activeStakes.map((s) => s.activationEpoch)) : null;

  // ── complete-as-possible signature history ─────────────────────────────────
  const { sigs, truncated } = await signaturesForAddress(wallet, { maxPages: MAX_SIG_PAGES });
  if (truncated) notes.push(`history truncated to most recent ${sigs.length} signatures — older activity approximated`);
  const okSigs = sigs.filter((s) => !s.err);
  const replaySigs = okSigs.slice(0, MAX_ENHANCED_TX);
  if (okSigs.length > replaySigs.length) notes.push(`replayed newest ${replaySigs.length} of ${okSigs.length} txs`);
  const replayComplete = !truncated && replaySigs.length === okSigs.length;

  // ── parsed-tx replay: wallet SOL deltas, LST deltas, and per-stake-account
  //    first contact (the earliest tx of THIS wallet touching that account) ────
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

  const acctIndex = new Map(activeStakes.map((s, i) => [s.address, i]));
  const firstContact = new Array(activeStakes.length).fill(null); // epoch of wallet's oldest tx touching the account
  let events = [];
  try {
    const txs = await enhancedTransactions(replaySigs.map((s) => s.signature));
    const bySig = new Map(txs.filter(Boolean).map((t) => [t.signature, t]));
    events = replaySigs.map((s) => { // newest → oldest, so the LAST write per account is its oldest contact
      const t = bySig.get(s.signature);
      if (!t) return null;
      const epoch = Math.floor(s.slot / SLOTS_PER_EPOCH);
      const acc = (t.accountData ?? []).find((a) => a.account === wallet);
      const lstDelta = {};
      for (const a of t.accountData ?? []) {
        const si = acctIndex.get(a.account);
        if (si !== undefined) firstContact[si] = epoch;
        for (const c of a.tokenBalanceChanges ?? []) {
          const meta = LST_MINTS[c.mint];
          if (meta && c.userAccount === wallet) {
            lstDelta[meta.symbol] = (lstDelta[meta.symbol] ?? 0) + Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals;
          }
        }
      }
      return { epoch, solDelta: (acc?.nativeBalanceChange ?? 0) / LAMPORTS, lstDelta };
    }).filter(Boolean);
  } catch (err) {
    notes.push(`enhanced-tx replay unavailable (${err.message}) — wallet balance held flat`);
  }
  const oldestReplayedEpoch = events.length ? events[events.length - 1].epoch : nowEpoch;

  // Attribution window per account: never before activation, never before this wallet
  // first touched it. Unknown contact: complete replay ⇒ the wallet truly never touched
  // it (attribute from now); incomplete ⇒ attribute from the replay window edge.
  const attrFrom = activeStakes.map((s, i) => {
    const contact = firstContact[i] ?? (replayComplete ? nowEpoch : oldestReplayedEpoch);
    return Math.max(s.activationEpoch, contact);
  });
  const acquired = activeStakes.filter((s, i) => attrFrom[i] > s.activationEpoch + 2).length;
  // Conveyor-belt detection: when most stake accounts arrived via authority handoff
  // (fee escrows, custodians, exchanges), the set churns and ANY historical attribution
  // swings build-to-build. Refuse to attribute history instead of guessing.
  const custodial = acquired >= 5 && acquired / Math.max(1, activeStakes.length) > 0.5;
  if (custodial) {
    notes.push(`custodial / flow-through pattern: ${acquired} of ${activeStakes.length} stake accounts were acquired via authority change — historical staking performance is not attributable to this wallet; showing current holdings only`);
    for (let i = 0; i < attrFrom.length; i++) attrFrom[i] = nowEpoch;
  } else if (acquired) {
    notes.push(`${acquired} of ${activeStakes.length} stake accounts were first touched by this wallet well after their activation — likely acquired via authority change; only history since first contact is attributed`);
  }
  if (activeStakes.length) {
    firstStakeEpoch = Math.min(...attrFrom); // may be lowered by the Marinade ledger's real deposit epochs below
  }

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

  const rewardSamples = []; // {epoch, span, perEpochSol, postSol} — per-account-filtered by attribution window
  if (!ledger && activeStakes.length) {
    const from = Math.max(1, Math.min(...attrFrom));
    const step = Math.max(1, Math.ceil((nowEpoch - from) / REWARD_SAMPLE_CALLS));
    const addrs = activeStakes.map((s) => s.address);
    const epochs = [];
    for (let e = from; e < nowEpoch; e += step) epochs.push(e);
    await pool(epochs, REWARD_CONCURRENCY, async (e) => {
      try {
        const res = await rpc('getInflationReward', [addrs, { epoch: e }]);
        let rew = 0, post = 0;
        for (let i = 0; i < res.length; i++) {
          if (!res[i] || e < attrFrom[i]) continue; // outside this wallet's attribution window
          rew += res[i].amount;
          post += res[i].postBalance; // the account's REAL balance at that epoch
        }
        rewardSamples.push({ epoch: e, span: Math.min(step, nowEpoch - e), perEpochSol: rew / LAMPORTS, postSol: post / LAMPORTS });
      } catch (err) {
        notes.push(`rewards sample @${e} failed: ${err.message}`);
      }
    });
    rewardSamples.sort((a, b) => a.epoch - b.epoch);
    rewardSamples.push({ epoch: nowEpoch, span: 0, perEpochSol: 0, postSol: stakeNowSol }); // anchor at today
    const maxPost = Math.max(...rewardSamples.map((s) => s.postSol));
    if (maxPost > 3 * Math.max(stakeNowSol, 1) && maxPost > 100) {
      notes.push(`sampled history shows past stake balances up to ${Math.round(maxPost).toLocaleString('en-US')} SOL vs ${Math.round(stakeNowSol).toLocaleString('en-US')} SOL today — treat historical attribution with extra caution`);
    }
    notes.push('rewards sampled on current stake accounts only — pre-merge/split lineage not traced'
      + (marinade?.status === 'Processing' ? ' (Marinade crawl in progress — recheck later for full lineage)' : ''));
  }
  const cumRewAt = ledger
    ? (e) => ledger.at(e).rewards
    : (e) => rewardSamples.reduce((t, s) => (s.epoch <= e ? t + s.perEpochSol * Math.min(s.span, e - s.epoch + 1) : t), 0);
  const totalStakeRewards = ledger ? ledger.totalRewards : cumRewAt(nowEpoch);

  // ── grid + point-in-time balances ──────────────────────────────────────────
  const firstSeenEpoch = events.length ? events[events.length - 1].epoch : (firstStakeEpoch ?? nowEpoch - 1);
  const startEpoch = Math.min(firstSeenEpoch, firstStakeEpoch ?? firstSeenEpoch);
  const step = Math.max(1, Math.ceil((nowEpoch - startEpoch) / 120));
  const grid = [];
  for (let e = startEpoch; e <= nowEpoch; e += step) grid.push(e);
  if (grid[grid.length - 1] !== nowEpoch) grid.push(nowEpoch);

  const walletAt = new Map(), lstAt = new Map();
  let preWindowBal = balanceNow;
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
    preWindowBal = sol;
  }
  // completeness self-check: a fully replayed history must walk back to ~0 at inception
  if (replayComplete && Math.abs(preWindowBal) > 1) {
    notes.push(`INTEGRITY: replaying the complete history back to inception leaves a ${preWindowBal.toFixed(2)} SOL residue (should be ~0) — some balance changes were not captured; treat reconstructed history with suspicion`);
  }

  // LSTs count as staking: first LST acquisition sets the first-stake epoch too
  // (custodial wallets excluded — transiting LSTs are not their positions)
  if (!custodial) {
    const firstLstEpoch = grid.find((e) => Object.values(lstAt.get(e) ?? {}).some((b) => b > 1e-6)) ?? null;
    if (firstLstEpoch !== null) firstStakeEpoch = firstStakeEpoch === null ? firstLstEpoch : Math.min(firstStakeEpoch, firstLstEpoch);
  }

  // ── compose series ─────────────────────────────────────────────────────────
  // Historical stake = the sampled REAL balances (getInflationReward postBalance),
  // step-interpolated, restricted to each account's attribution window.
  const stakeAtSampled = (e) => {
    let v = 0;
    for (const s of rewardSamples) { if (s.epoch <= e) v = s.postSol; else break; }
    return v;
  };
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
      if (i > 0 && !custodial) { // custodial: transiting LST yield is not attributable
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
  //   full: yield on ALL holdings (hold trajectory)             → "all-in from day one"
  //   mnde: yield on the actual staked exposure, native + LST   → "Marinade ran my staking"
  const EPOCH_SEC = 197_000; // ~2.28 days
  const nowSec = Date.now() / 1000;
  const epochUnix = (e) => nowSec - (nowEpoch - e) * EPOCH_SEC;
  const full = [], mnde = [];
  let fullPot = 0, mndePot = 0;
  for (let i = 0; i < grid.length; i++) {
    if (i > 0 && !custodial) { // custodial: counterfactuals are as meaningless as the history
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

  if (hold[hold.length - 1] < 1e-6 && you[you.length - 1] > 1) {
    notes.push('the unstaked baseline bottoms out at 0: this wallet moved out more SOL than its reward-free balance — typical for wallets that transferred funds elsewhere, or flow-through/custodial wallets (escrows, exchanges), which this tool does not model');
  }

  // sanity invariants — violations are surfaced, never silently shipped
  for (let i = 0; i < grid.length; i++) {
    if (full[i] < hold[i] - 1e-6 || mnde[i] < hold[i] - 1e-6 || you[i] < hold[i] - 1e-6) {
      notes.push(`INVARIANT VIOLATION at epoch ${grid[i]} — hold/you/mnde/full ordering broken, treat this report with suspicion`);
      break;
    }
  }

  const earned = totalStakeRewards + lstApprCum[lstApprCum.length - 1];
  const potential = fullPot;
  const stakedSpan = grid.filter((e) => e >= (firstStakeEpoch ?? startEpoch));
  const avgStaked = stakedSpan.length // LSTs at SOL value — same denomination as `earned`
    ? stakedSpan.reduce((t, e) => t + stakeAt(e) + lstValueAt(e, true), 0) / stakedSpan.length : 0;
  // APYs as time-weighted returns: geometric linking of per-step reward rates —
  // an earned/avg-stake formula badly overstates yield when the stake grew over time.
  //   effApy:  reward rate on the staked exposure (native + LST SOL-value)
  //   totalApy: same rewards on ALL SOL held — ≤ effApy by construction (idle dilutes)
  let gStaked = 1, gTotal = 1;
  for (let i = 1; i < grid.length; i++) {
    const dRew = (cumRewAt(grid[i]) + lstApprCum[i]) - (cumRewAt(grid[i - 1]) + lstApprCum[i - 1]);
    if (dRew <= 0) continue;
    const expS = (stakeAt(grid[i - 1]) + lstValueAt(grid[i - 1], true)) || (stakeAt(grid[i]) + lstValueAt(grid[i], true));
    const expT = balTraj[i - 1] || balTraj[i];
    if (expS > 1e-6) gStaked *= 1 + dRew / expS;
    if (expT > 1e-6) gTotal *= 1 + dRew / expT;
  }
  const yearsSpan = (nowEpoch - (firstStakeEpoch ?? startEpoch)) / 160;
  const firstHeld = grid.find((e, i) => balTraj[i] > 1e-6);
  const yearsHold = firstHeld !== undefined ? Math.max(0.01, (nowEpoch - firstHeld) / 160) : 0;
  const effApy = yearsSpan > 0.01 && gStaked > 1 ? Math.pow(gStaked, 1 / yearsSpan) - 1 : 0;
  const totalApy = yearsHold > 0.01 && gTotal > 1 ? Math.min(effApy, Math.pow(gTotal, 1 / yearsHold) - 1) : 0;

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
      version: 'poc-0.8.0', // bumped on any math/semantics change so number shifts are attributable
      benchmark: bench,
      marinadeCrawl: marinade?.status ?? 'Unknown',
      rewardsSource: ledger ? 'marinade-report' : 'helius-sampled',
      stakeAccounts: stakes.length,
      acquiredAccounts: acquired,
      custodial,
      replayComplete,
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
