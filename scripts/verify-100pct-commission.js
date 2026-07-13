// Empirically check what getInflationReward returns for a stake account delegated to a
// 100%-commission validator (delegator reward = 0): null, or {amount:0, postBalance>0}?
// Our sampled path skips null (would drop the stake from "staked exposure"); it counts amount:0.
import './lib/bootstrap.js';
import { rpc } from './lib/rpc.js';

const STAKE = 'Stake11111111111111111111111111111111111111';
const LAMPORTS = 1e9;
const epochInfo = await rpc('getEpochInfo');
const nowEpoch = epochInfo.epoch;
const testEpoch = nowEpoch - 2; // a safely-completed epoch
console.log(`now epoch ${nowEpoch}; probing rewards for epoch ${testEpoch}\n`);

// 1) validators with 100% commission that actually have stake delegated
const va = await rpc('getVoteAccounts');
const all = [...va.current, ...va.delinquent];
const full = all.filter((v) => v.commission === 100 && Number(v.activatedStake) > 5 * LAMPORTS)
  .sort((a, b) => Number(b.activatedStake) - Number(a.activatedStake));
console.log(`100%-commission validators with stake: ${full.length}`);
if (!full.length) { console.log('none found — cannot test'); process.exit(0); }

// helper: first stake account delegated to a given vote pubkey (voter at offset 124)
async function stakeFor(votePubkey) {
  const accs = await rpc('getProgramAccounts', [STAKE, {
    encoding: 'jsonParsed',
    filters: [{ dataSize: 200 }, { memcmp: { offset: 124, bytes: votePubkey } }],
  }]).catch(() => []);
  for (const a of accs) {
    const d = a.account.data.parsed?.info?.stake?.delegation;
    if (d && Number(d.activationEpoch) <= testEpoch && Number(d.deactivationEpoch) > testEpoch) {
      return { pubkey: a.pubkey, activationEpoch: Number(d.activationEpoch), lamports: a.account.lamports };
    }
  }
  return null;
}

let tested = 0;
for (const v of full.slice(0, 8)) {
  const st = await stakeFor(v.votePubkey);
  if (!st) continue;
  const res = await rpc('getInflationReward', [[st.pubkey], { epoch: testEpoch }]);
  const r = res[0];
  console.log(`--- 100%% validator ${v.votePubkey.slice(0, 8)} (stake ${(Number(v.activatedStake) / LAMPORTS).toFixed(0)} SOL) ---`);
  console.log(`  stake acct ${st.pubkey.slice(0, 8)} (~${(st.lamports / LAMPORTS).toFixed(2)} SOL, active since ep ${st.activationEpoch})`);
  console.log(`  getInflationReward[0] = ${JSON.stringify(r)}`);
  console.log(`  => ${r === null ? 'NULL (our loop would SKIP → stake not counted as exposure)' : `OBJECT amount=${r.amount} postBalance=${r.postBalance} (counted; amount ${r.amount === 0 ? '== 0 as hoped' : '> 0 ??'})`}\n`);
  if (++tested >= 3) break;
}
if (!tested) console.log('found 100%-commission validators but no active stake account matched the test epoch');

// 2) CONTROL: a normal (low-commission, high-stake) validator should return amount>0
const normal = va.current.filter((v) => v.commission <= 10 && Number(v.activatedStake) > 1e6 * LAMPORTS)[0];
if (normal) {
  const st = await stakeFor(normal.votePubkey);
  if (st) {
    const r = (await rpc('getInflationReward', [[st.pubkey], { epoch: testEpoch }]))[0];
    console.log(`--- CONTROL ${normal.commission}%% validator ${normal.votePubkey.slice(0, 8)} ---`);
    console.log(`  getInflationReward[0] = ${JSON.stringify(r)}`);
    // 3) CONTROL: same account BEFORE it activated should be null
    const before = Math.max(1, st.activationEpoch - 5);
    const rb = (await rpc('getInflationReward', [[st.pubkey], { epoch: before }]))[0];
    console.log(`  same acct at ep ${before} (pre-activation) = ${JSON.stringify(rb)} → ${rb === null ? 'NULL (confirms null=no-reward shape)' : 'object'}`);
  }
}
