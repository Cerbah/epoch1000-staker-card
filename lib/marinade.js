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

export async function crawlStatus(wallet) {
  try {
    const r = await fetch(`${BASE}/v1/status?withdraw=${wallet}`);
    if (!r.ok) return { status: 'Unknown', http: r.status };
    return await r.json(); // { withdraw, status, done_time, to_slot, ... }
  } catch (e) {
    return { status: 'Unreachable', error: String(e) };
  }
}

export async function report(withdraw, stake) {
  const r = await fetch(`${BASE}/v1/report?withdraw=${withdraw}&stake=${stake}`);
  if (!r.ok) throw new Error(`/v1/report(${stake.slice(0, 6)}…) HTTP ${r.status}`);
  return await r.json(); // { data: [{ slot, block_time, txs: [{ tx_sig, profit?, deposit?, withdraw?, loss? }] }] }
}

// Merge one or more /v1/report payloads into an epoch-ordered ledger:
//   entries: [{epoch, deposit, withdraw, rewards}]  (SOL, per epoch)
//   cum:     [{epoch, rewards, principal}]          (SOL, cumulative)
export function buildLedger(reports) {
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
