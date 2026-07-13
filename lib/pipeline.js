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
import { LST_MINTS, currentRates, rateAtEpoch, recordedRateAt, rateHistorySpan } from './lst.js';
import { benchmark } from './benchmark.js';
import { crawlStatus, report, buildLedger } from './marinade.js';

const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
const SLOTS_PER_EPOCH = 432_000;
const LAMPORTS = 1e9;
// Depth budgets — sized to replay MOST wallets to inception on a paid Helius plan
// ("right first time"); only true monsters get truncated, loudly.
const MAX_SIG_PAGES = Number(process.env.MAX_SIG_PAGES ?? 20);          // ×1000 sigs history cap
const MAX_ENHANCED_TX = Number(process.env.MAX_ENHANCED_TX ?? 20000);   // parsed-tx replay budget
const MAX_LST_SIG_PAGES = Number(process.env.MAX_LST_SIG_PAGES ?? 80);  // ×1000 per-ATA sig cap (listing only, cheap)
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

  // ── current balances (wallet SOL + LST token accounts) ─────────────────────
  const balanceNow = (await rpc('getBalance', [wallet])).value / LAMPORTS;
  const lstNow = {};
  const lstAtas = []; // { pubkey, symbol } per held LST token account — see lstBalancesAt()
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const tokenAccs = await rpc('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed' }]);
    for (const ta of tokenAccs.value) {
      const info = ta.account.data.parsed.info;
      const meta = LST_MINTS[info.mint];
      if (!meta) continue;
      lstNow[meta.symbol] = (lstNow[meta.symbol] ?? 0) + Number(info.tokenAmount.uiAmount ?? 0);
      if (Number(info.tokenAmount.uiAmount ?? 0) > 0) lstAtas.push({ pubkey: ta.pubkey, symbol: meta.symbol });
    }
  }

  // List each held LST token account's signatures up-front — needed both to extend the
  // grid to the earliest LST activity (inbound transfers never appear in the WALLET's own
  // history) and to read per-epoch absolute balances later (lstBalancesAt).
  const lstAtaData = await Promise.all(lstAtas.map(async ({ pubkey, symbol }) => {
    const { sigs, truncated } = await signaturesForAddress(pubkey, { maxPages: MAX_LST_SIG_PAGES });
    return { pubkey, symbol, ok: sigs.filter((s) => !s.err), truncated }; // ok: newest → oldest
  }));
  const curAtaSet = new Set(lstAtas.map((a) => a.pubkey));
  let firstLstTxEpoch = null; // computed after since-closed LST token accounts are merged (below)

  // ── complete-as-possible signature history (wallet only — LST balances are
  //    reconstructed separately from absolute post-balances, see lstBalancesAt) ─
  const { sigs, truncated } = await signaturesForAddress(wallet, { maxPages: MAX_SIG_PAGES });
  if (truncated) notes.push(`history truncated to most recent ${sigs.length} signatures — older activity approximated`);
  const okSigs = sigs.filter((s) => !s.err);
  const replaySigs = okSigs.slice(0, MAX_ENHANCED_TX);
  if (okSigs.length > replaySigs.length) notes.push(`replayed newest ${replaySigs.length} of ${okSigs.length} txs`);
  const replayComplete = !truncated && replaySigs.length === okSigs.length;

  // ── parsed-tx replay: wallet SOL deltas and per-stake-account first contact
  //    (the earliest tx of THIS wallet touching that account) ───────────────────

  const acctIndex = new Map(activeStakes.map((s, i) => [s.address, i]));
  const firstContact = new Array(activeStakes.length).fill(null); // epoch of wallet's oldest tx touching the account
  const stakeSeen = new Map(); // since-closed stake account → earliest epoch the wallet staked into it
  const histLstSeen = new Map(); // LST token account the wallet ever held → symbol (incl. since-sold/closed)
  const STAKE_TX = /STAKE|UNSTAKE|WITHDRAW|DELEGATE|DEACTIVATE|SPLIT/i;
  let events = [];
  try {
    const txs = await enhancedTransactions(replaySigs.map((s) => s.signature));
    const bySig = new Map(txs.filter(Boolean).map((t) => [t.signature, t]));
    events = replaySigs.map((s) => { // newest → oldest, so the LAST write per account is its oldest contact
      const t = bySig.get(s.signature);
      if (!t) return null;
      const epoch = Math.floor(s.slot / SLOTS_PER_EPOCH);
      const acc = (t.accountData ?? []).find((a) => a.account === wallet);
      for (const a of t.accountData ?? []) { // per-stake-account first contact (LST balances are handled separately)
        const si = acctIndex.get(a.account);
        if (si !== undefined) firstContact[si] = epoch;
      }
      // discover stake accounts the wallet ever funded/drained — incl. ones since closed,
      // which getProgramAccounts can no longer see (getInflationReward still can, below)
      // only the WALLET's OWN stake txs (it paid the fee) — otherwise a stake account
      // arriving via someone else's withdrawal would wrongly get its lifetime rewards
      // attributed here. getInflationReward later confirms each candidate is a real stake acct.
      if (t.feePayer === wallet && (STAKE_TX.test(t.type || '') || (t.instructions ?? []).some((i) => i.programId === STAKE_PROGRAM))) {
        for (const n of t.nativeTransfers ?? []) {
          const cp = n.fromUserAccount === wallet ? n.toUserAccount : (n.toUserAccount === wallet ? n.fromUserAccount : null);
          if (cp && cp !== wallet && (n.amount ?? 0) / LAMPORTS > 0.5 && !acctIndex.has(cp)) {
            const prev = stakeSeen.get(cp);
            if (prev === undefined || epoch < prev) stakeSeen.set(cp, epoch);
          }
        }
      }
      // discover the wallet's LST token accounts — incl. ones it fully sold & closed, which
      // getTokenAccountsByOwner no longer returns. Reading their full balance history counts
      // the LST while it was held; once sold it drops to 0 (to SOL → tracked as native; to
      // another token → a value exit, same as sending SOL off).
      for (const tt of t.tokenTransfers ?? []) {
        const meta = LST_MINTS[tt.mint];
        if (!meta) continue;
        if (tt.fromUserAccount === wallet && tt.fromTokenAccount) histLstSeen.set(tt.fromTokenAccount, meta.symbol);
        if (tt.toUserAccount === wallet && tt.toTokenAccount) histLstSeen.set(tt.toTokenAccount, meta.symbol);
      }
      return { epoch, solDelta: (acc?.nativeBalanceChange ?? 0) / LAMPORTS };
    }).filter(Boolean);
  } catch (err) {
    notes.push(`enhanced-tx replay unavailable (${err.message}) — wallet balance held flat`);
  }
  const oldestReplayedEpoch = events.length ? events[events.length - 1].epoch : nowEpoch;

  // Merge since-sold/closed LST token accounts (discovered in the replay) into the set we
  // reconstruct per-epoch, so LSTs the wallet no longer holds are still counted while held.
  const extraAtas = [...histLstSeen].filter(([pk]) => !curAtaSet.has(pk)).map(([pubkey, symbol]) => ({ pubkey, symbol }));
  if (extraAtas.length) {
    lstAtaData.push(...await Promise.all(extraAtas.map(async ({ pubkey, symbol }) => {
      const { sigs, truncated } = await signaturesForAddress(pubkey, { maxPages: MAX_LST_SIG_PAGES });
      return { pubkey, symbol, ok: sigs.filter((s) => !s.err), truncated };
    })));
    notes.push(`included ${extraAtas.length} since-sold/closed LST token account(s) from history — LSTs later sold or exited are counted while held`);
  }
  for (const d of lstAtaData) if (d.truncated) notes.push(`${d.symbol} history: token-account signatures truncated at ${d.ok.length} — epochs before the crawl window shown as 0`);
  for (const d of lstAtaData) { // earliest observed LST tx → extends the grid back to acquisition
    const oldest = d.ok[d.ok.length - 1];
    if (oldest) { const e = Math.floor(oldest.slot / SLOTS_PER_EPOCH); firstLstTxEpoch = firstLstTxEpoch === null ? e : Math.min(firstLstTxEpoch, e); }
  }

  // Attribution window per account: never before activation, never before this wallet
  // first touched it. Unknown contact: complete replay ⇒ the wallet truly never touched
  // it (attribute from now); incomplete ⇒ attribute from the replay window edge.
  const attrFrom = activeStakes.map((s, i) => {
    const contact = firstContact[i] ?? (replayComplete ? nowEpoch : oldestReplayedEpoch);
    return Math.max(s.activationEpoch, contact);
  });
  const acquired = activeStakes.filter((s, i) => attrFrom[i] > s.activationEpoch + 2).length;
  // Conveyor-belt detection: when most stake accounts arrived via authority handoff
  // (fee escrows, custodians, exchanges). History IS still tracked — wallet SOL and
  // LST balances exactly, stake accounts only while under this wallet's authority
  // (the first-contact windows) — but long-term performance framing deserves caution.
  const custodial = acquired >= 5 && acquired / Math.max(1, activeStakes.length) > 0.5;
  if (custodial) {
    notes.push(`custodial / flow-through pattern: ${acquired} of ${activeStakes.length} stake accounts arrived via authority change — stake history is attributed only while under this wallet's authority; interpret long-term performance with care`);
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

  // since-closed native stake accounts the wallet controlled (discovered during replay).
  // getProgramAccounts can't see them now, but getInflationReward still returns their
  // per-epoch balance & reward — so native staking that was later withdrawn is not lost.
  const histStake = [...stakeSeen.keys()].slice(0, 60);
  if (histStake.length) {
    const hf = Math.min(...histStake.map((a) => stakeSeen.get(a)));
    firstStakeEpoch = firstStakeEpoch === null ? hf : Math.min(firstStakeEpoch, hf);
  }
  const rewardSamples = []; // {epoch, span, perEpochSol, postSol}
  if (!ledger && (activeStakes.length || histStake.length)) {
    const curFrom = attrFrom.length ? Math.min(...attrFrom) : nowEpoch;
    const histFrom = histStake.length ? Math.min(...histStake.map((a) => stakeSeen.get(a))) : nowEpoch;
    const from = Math.max(1, Math.min(curFrom, histFrom));
    const step = Math.max(1, Math.ceil((nowEpoch - from) / REWARD_SAMPLE_CALLS));
    const addrs = [...activeStakes.map((s) => s.address), ...histStake];
    const attrExt = [...attrFrom, ...histStake.map(() => 1)]; // historical accts: their whole active life is the wallet's
    const epochs = [];
    for (let e = from; e < nowEpoch; e += step) epochs.push(e);
    await pool(epochs, REWARD_CONCURRENCY, async (e) => {
      try {
        const res = await rpc('getInflationReward', [addrs, { epoch: e }]);
        let rew = 0, post = 0;
        for (let i = 0; i < res.length; i++) {
          if (!res[i] || e < attrExt[i]) continue; // outside this wallet's attribution window
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
    if (histStake.length) notes.push(`included ${histStake.length} since-closed stake account(s) discovered from history — native staking that was later withdrawn is counted`);
    const maxPost = Math.max(...rewardSamples.map((s) => s.postSol));
    if (maxPost > 3 * Math.max(stakeNowSol, 1) && maxPost > 100) {
      notes.push(`sampled history shows past stake balances up to ${Math.round(maxPost).toLocaleString('en-US')} SOL vs ${Math.round(stakeNowSol).toLocaleString('en-US')} SOL today — treat historical attribution with extra caution`);
    }
    notes.push('rewards sampled via getInflationReward on current + historically-discovered stake accounts — pre-merge/split lineage not traced'
      + (marinade?.status === 'Processing' ? ' (Marinade crawl in progress — recheck later for full lineage)' : ''));
  }
  const cumRewAt = ledger
    ? (e) => ledger.at(e).rewards
    : (e) => rewardSamples.reduce((t, s) => (s.epoch <= e ? t + s.perEpochSol * Math.min(s.span, e - s.epoch + 1) : t), 0);
  const totalStakeRewards = ledger ? ledger.totalRewards : cumRewAt(nowEpoch);

  // ── grid + point-in-time balances ──────────────────────────────────────────
  const firstSeenEpoch = events.length ? events[events.length - 1].epoch : (firstStakeEpoch ?? nowEpoch - 1);
  const startEpoch = Math.min(firstSeenEpoch, firstStakeEpoch ?? firstSeenEpoch, firstLstTxEpoch ?? firstSeenEpoch);
  const step = Math.max(1, Math.ceil((nowEpoch - startEpoch) / 120));
  const grid = [];
  for (let e = startEpoch; e <= nowEpoch; e += step) grid.push(e);
  if (grid[grid.length - 1] !== nowEpoch) grid.push(nowEpoch);

  // Point-in-time wallet SOL at each grid epoch. When the replay is COMPLETE, the backward
  // delta walk is exact (it reaches ~0 at inception). When it's TRUNCATED, that walk would
  // project today's balance back and invent a phantom early balance — so fall back to
  // ABSOLUTE on-chain balances (last tx ≤ boundary), which can't phantom (mirrors LSTs).
  let walletAt;
  if (replayComplete) {
    walletAt = new Map();
    let sol = balanceNow, gi = grid.length - 1;
    walletAt.set(nowEpoch, sol);
    for (const ev of events) { while (gi > 0 && grid[gi - 1] >= ev.epoch) { gi--; walletAt.set(grid[gi], sol); } sol -= ev.solDelta; }
    while (gi > 0) { gi--; walletAt.set(grid[gi], sol); }
  } else {
    walletAt = await nativeBalancesAt(okSigs, grid, nowEpoch, wallet, balanceNow);
  }

  // LST balance at each epoch boundary = the ABSOLUTE on-chain balance from the last tx
  // at/before that boundary (getTransaction.meta.postTokenBalances), NOT accumulated
  // deltas. Anchoring to absolute balances means a missed transfer can never inflate
  // history into a phantom — the chart shows exactly what the wallet held at each epoch's
  // end, which is what a staking/unstaking report needs.
  const lstAt = await lstBalancesAt(lstAtaData, grid, nowEpoch, wallet, lstNow);

  // LST rate at epoch e: prefer the EXACT recorded rate (trusted per-epoch history), else
  // back-compound the current rate at the mSOL benchmark. As the recorder accumulates
  // epochs, more of history uses each LST's own true rate instead of the benchmark.
  // current epoch → exact live rate (keeps holdings exact); past epochs → recorded exact
  // rate if we have it, else benchmark back-compound.
  const lstRateAt = (sym, e) => (e >= nowEpoch ? (rates[sym] ?? 1)
    : (recordedRateAt(sym, e) ?? rateAtEpoch(rates[sym] ?? 1, bench.perEpoch, nowEpoch, e)));
  const rhSpan = rateHistorySpan();
  if (rhSpan) notes.push('LST holdings are valued with exact per-epoch exchange rates from recorded on-chain history (mSOL back to its Aug-2021 launch; other LSTs from their first tracked price). Only epochs before a token was tracked fall back to an estimate — its current rate back-compounded at mSOL\'s yield.');

  // LSTs count as staking: first LST acquisition sets the first-stake epoch too
  const firstLstEpoch = grid.find((e) => Object.values(lstAt.get(e) ?? {}).some((b) => b > 1e-6)) ?? null;
  if (firstLstEpoch !== null) firstStakeEpoch = firstStakeEpoch === null ? firstLstEpoch : Math.min(firstStakeEpoch, firstLstEpoch);

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
    .reduce((t, [sym, bal]) => t + Math.max(0, bal) * (useRate ? lstRateAt(sym, e) : 1), 0);
  // LST yield accrues on the balance actually held while it was held (rate growth ×
  // holding), so the exchange-rate premium at acquisition is cost basis, not "earned".
  const lstApprCum = [];
  { let acc = 0;
    for (let i = 0; i < grid.length; i++) {
      if (i > 0) {
        for (const [sym, bal] of Object.entries(lstAt.get(grid[i - 1]) ?? {})) {
          if (bal > 0) acc += bal * (lstRateAt(sym, grid[i]) - lstRateAt(sym, grid[i - 1]));
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
  // per-epoch staked exposure (native stake + LST SOL-value) vs idle wallet SOL → % staked
  const stakedSeries = grid.map((e) => stakeAt(e) + lstValueAt(e, true));
  const idleSeries = grid.map((e) => Math.max(0, walletAt.get(e) ?? 0));
  const stakedPct = grid.map((_, i) => { const tot = stakedSeries[i] + idleSeries[i]; return tot > 1e-6 ? stakedSeries[i] / tot : 0; });
  // "First staked" = first epoch with MEANINGFUL staked exposure, not a dust deposit or an
  // early-activating acquired account. Otherwise the card + chart marker claim "staked since
  // <year>" (e.g. 2021) while the balance was ~0 until much later. Re-anchor to real onset.
  {
    const maxStk = Math.max(0, ...stakedSeries);
    const mi = maxStk > 0 ? stakedSeries.findIndex((v) => v >= Math.max(1, 0.02 * maxStk)) : -1;
    if (mi >= 0) firstStakeEpoch = firstStakeEpoch === null ? grid[mi] : Math.max(firstStakeEpoch, grid[mi]);
  }
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
  // Benchmark step growth = how much 1 mSOL ACTUALLY grew in SOL terms over [e0,e1], read
  // straight from mSOL's own recorded exchange-rate history (exact, launch→now). This is the
  // true "held 100% mSOL" counterfactual. Only if a boundary rate is missing (an epoch before
  // mSOL was tracked) do we fall back to the rolling-APY series / its flat clamp.
  const benchStep = (e0, e1) => {
    const r0 = recordedRateAt('mSOL', e0), r1 = recordedRateAt('mSOL', e1);
    if (r0 > 0 && r1 > 0) return Math.max(0, r1 / r0 - 1);
    return Math.pow(1 + bench.perEpochAt(epochUnix(e0)), e1 - e0) - 1;
  };
  const full = [], mnde = [];
  let fullPot = 0, mndePot = 0;
  for (let i = 0; i < grid.length; i++) {
    if (i > 0) {
      const g = benchStep(grid[i - 1], grid[i]);
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
  // flow-through wallets (custodial, or moved out more than their reward-free balance) —
  // performance metrics are meaningless for them; the UI shows a caveat instead of a grade.
  const flowThrough = custodial || (hold[hold.length - 1] < 1e-6 && you[you.length - 1] > 1);
  const stakedSpan = grid.filter((e) => e >= (firstStakeEpoch ?? startEpoch));
  const avgStaked = stakedSpan.length // LSTs at SOL value — same denomination as `earned`
    ? stakedSpan.reduce((t, e) => t + stakeAt(e) + lstValueAt(e, true), 0) / stakedSpan.length : 0;
  // APYs as time-weighted returns: geometric linking of per-step reward rates —
  // an earned/avg-stake formula badly overstates yield when the stake grew over time.
  //   effApy:  reward rate on the staked exposure (native + LST SOL-value)
  //   totalApy: same rewards on ALL SOL held — ≤ effApy by construction (idle dilutes)
  // Cap the per-step reward RATE: a real staking step yields well under 5% of the staked
  // exposure. A larger ratio means the reward was attributed to a near-zero exposure (an
  // idle/exit step, common when history is truncated) — a reconstruction artifact, not real
  // yield. Skipping those keeps the geometric APY from exploding (e.g. a phantom 54% APY).
  const MAX_STEP_RATE = 0.05;
  let gStaked = 1, gTotal = 1;
  for (let i = 1; i < grid.length; i++) {
    const dRew = (cumRewAt(grid[i]) + lstApprCum[i]) - (cumRewAt(grid[i - 1]) + lstApprCum[i - 1]);
    if (dRew <= 0) continue;
    const expS = (stakeAt(grid[i - 1]) + lstValueAt(grid[i - 1], true)) || (stakeAt(grid[i]) + lstValueAt(grid[i], true));
    const expT = balTraj[i - 1] || balTraj[i];
    const rS = expS > 1e-6 ? dRew / expS : 0, rT = expT > 1e-6 ? dRew / expT : 0;
    if (rS > 0 && rS < MAX_STEP_RATE) gStaked *= 1 + rS;
    if (rT > 0 && rT < MAX_STEP_RATE) gTotal *= 1 + rT;
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
    series: { eps: grid, hold: rnd(hold), you: rnd(you), full: rnd(full), mnde: rnd(mnde), stakedPct: rnd(stakedPct), stakedSol: rnd(stakedSeries), idleSol: rnd(idleSeries) },
    card: {
      earnedSol: r4(earned),
      stakedSol: r4(stakeNowSol + lstValueAt(nowEpoch, true)),
      holdingsSol: r4(balTraj[balTraj.length - 1]), // actual current balance (chart "you" ends at baseline + kept rewards)
      avgStakedSol: r4(avgStaked),
      firstStakeEpoch,
      epochsStaked: firstStakeEpoch !== null ? nowEpoch - firstStakeEpoch : 0,
      effApy: r4(effApy),
      totalApy: r4(totalApy),
      // "capture" = your rewards vs the mSOL benchmark ON THE SOL YOU ACTUALLY STAKED
      // (not on idle cash / not "all-in from day one"). Unclamped: >1 means you beat mSOL
      // (e.g. a higher-yield LST). null for flow-through wallets where it's meaningless.
      benchmark: 'mSOL',
      flowThrough,
      captureVsMsol: flowThrough || mndePot <= 1e-6 ? null : r4(earned / mndePot),
      missedSol: flowThrough ? null : r4(Math.max(0, mndePot - earned)), // mSOL yield left on the table on YOUR staked exposure
      allInPotentialSol: r4(fullPot),              // aspirational "all-in mSOL from day one on all holdings" (chart line only)
      mndeRewardsSol: r4(mndePot),                 // what mSOL would have yielded on your staked exposure (native + LST)
      mndeDeltaSol: r4(mndePot - earned),          // >0: mSOL benchmark beats your actual reward stream
    },
    meta: {
      version: 'poc-0.20.0', // bumped on any math/semantics change so number shifts are attributable
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

// Wallet native SOL at each grid epoch boundary, from the ABSOLUTE post-balance of the last
// wallet tx ≤ boundary (meta.postBalances). No delta accumulation ⇒ a truncated/partial
// replay can't invent a phantom early balance; pre-first-tx epochs are 0, gaps carry the
// last known balance. nowEpoch is anchored to the exact current balance.
async function nativeBalancesAt(okSigs, grid, nowEpoch, wallet, balanceNow) {
  const at = new Map(grid.map((e) => [e, 0]));
  at.set(nowEpoch, balanceNow);
  const boundaries = grid.filter((e) => e !== nowEpoch).map((e) => ({ e, endSlot: (e + 1) * SLOTS_PER_EPOCH - 1 }));
  const anchor = new Map();
  for (const { e, endSlot } of boundaries) {
    const s = okSigs.find((x) => x.slot <= endSlot); // newest→oldest ⇒ first ≤ endSlot is the latest ≤ boundary
    if (s) anchor.set(e, s.signature);
  }
  const balBySig = new Map();
  await pool([...new Set(anchor.values())], REWARD_CONCURRENCY, async (sig) => {
    try {
      const t = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }], { retries: 6 });
      const keys = accountKeyList(t); const i = keys.indexOf(wallet);
      balBySig.set(sig, i >= 0 && t?.meta?.postBalances ? t.meta.postBalances[i] / LAMPORTS : null);
    } catch { balBySig.set(sig, null); }
  });
  let carry = 0; // before the first tx the wallet held 0; carry last-known across gaps/nulls
  for (const e of grid) {
    if (e === nowEpoch) continue;
    if (anchor.has(e)) { const b = balBySig.get(anchor.get(e)); if (b != null) carry = b; }
    at.set(e, carry);
  }
  return at;
}

// Point-in-time LST balances at each grid epoch's boundary (end of epoch), read from the
// ABSOLUTE on-chain balance (getTransaction.meta.postTokenBalances) of the last tx that
// touched the token account at/before the boundary. No delta accumulation ⇒ a missed
// transfer can't inflate history into a phantom; the worst case is a stale-but-real prior
// balance until the next observed change. Each held token account is read INDEPENDENTLY
// (matched by account address, then summed) so a wallet holding one mint across several
// accounts is neither double-counted nor dropped. `nowEpoch` is anchored to the exact
// current balances. `ataData` = pre-listed [{pubkey, symbol, ok}] (ok newest→oldest).
// Returns Map<epoch, {symbol: balance}>.
async function lstBalancesAt(ataData, grid, nowEpoch, wallet, lstNow) {
  const lstAt = new Map(grid.map((e) => [e, {}]));
  lstAt.set(nowEpoch, { ...lstNow }); // today = authoritative current balances
  const boundaries = grid.filter((e) => e !== nowEpoch).map((e) => ({ e, endSlot: (e + 1) * SLOTS_PER_EPOCH - 1 }));
  for (const { pubkey, symbol, ok } of ataData) {
    // ok is newest→oldest, so the first entry with slot ≤ endSlot is the latest tx ≤ boundary
    const anchor = new Map(); // epoch → signature
    for (const { e, endSlot } of boundaries) {
      const s = ok.find((x) => x.slot <= endSlot);
      if (s) anchor.set(e, s.signature);
    }
    const balBySig = new Map();
    await pool([...new Set(anchor.values())], REWARD_CONCURRENCY, async (sig) => {
      try {
        const t = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }], { retries: 6 });
        balBySig.set(sig, tokenBalanceOfAccount(t, pubkey));
      } catch { balBySig.set(sig, null); }
    });
    for (const { e } of boundaries) {
      const bal = anchor.has(e) ? balBySig.get(anchor.get(e)) : null;
      if (bal) { const m = lstAt.get(e); m[symbol] = (m[symbol] ?? 0) + bal; }
    }
  }
  return lstAt;
}

// Absolute balance of a SPECIFIC token account after a tx, from meta.postTokenBalances —
// matched by resolving accountIndex through the full account-key list (static keys plus
// any address-lookup-table-loaded addresses). Matching the account, not just owner+mint,
// is what prevents double-counting a wallet's multiple accounts of the same mint. Returns
// null when the account has no post balance in this tx (e.g. it was just closed) — callers
// treat null as "not held" (0).
function tokenBalanceOfAccount(t, account) {
  const msg = t?.transaction?.message;
  if (!msg) return null;
  const keys = [
    ...(msg.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(t.meta?.loadedAddresses?.writable ?? []),
    ...(t.meta?.loadedAddresses?.readonly ?? []),
  ];
  const pb = (t.meta?.postTokenBalances ?? []).find((p) => keys[p.accountIndex] === account);
  return pb ? Number(pb.uiTokenAmount.uiAmountString) : null;
}

const r4 = (n) => Math.round(n * 1e4) / 1e4;
const rnd = (a) => a.map(r4);
