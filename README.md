# Epoch 1000 — Staking Performance PoC (live data)

Fork of the solana.com/epoch1000 concept: paste a wallet, get a shareable "staker card"
(rewards earned, grade, PNG export) and a three-timeline chart — never staked vs. your
staking vs. fully staked from day one.

## Run (personal / local)

```bash
cp .env.example .env    # put your HELIUS_API_KEY in it (that's the only required value)
npm install             # one dependency (undici, proxy support — inert outside proxies)
node server.js          # → http://localhost:4180
```

Needs Node ≥ 20. The page has ⚡ live demo chips (real wallets) and a 🎲 sim chip
(seeded mock, also the fallback when the API is unreachable — results carry a
SIMULATED / LIVE badge). A "🕶 Hide amounts" toggle strips the wallet and SOL amounts
from the card, PNG, and tweet (keeps %, grade, epochs, APY) for private sharing.

## Hosting (handover)

The app is a single Node process serving static HTML + `/api/*`; the Helius key must
stay server-side, so GitHub Pages alone won't work — pair a GitHub repo with any free
Node host:

1. Push this folder to a GitHub repo (`.gitignore` already excludes `.env`, caches, logs).
2. Deploy to Render / Railway / Fly.io free tier — or any box with `docker build . && docker run -e HELIUS_API_KEY=… -p 4180:4180 …`
   (Dockerfile included). Set `HELIUS_API_KEY` as a secret env var; done.
3. `cache/` and `data/checks.jsonl` are plain files — mount a volume if you want them
   to survive redeploys.

## Data pipeline (`lib/pipeline.js`)

| Step | Source | Notes |
|------|--------|-------|
| Stake accounts | Helius `getProgramAccounts` (Stake program, memcmp withdrawer@44) | includes staker authority per account |
| Native rewards (primary) | Marinade `staking-rewards-api` `/v1/report?withdraw=&stake=` per distinct stake authority when `/v1/status` is `Ready` | full merge/split lineage incl. **MEV & PSR**; ledger anchored to the on-chain balance from the crawl boundary |
| Native rewards (fallback) | Helius `getInflationReward` (archival, verified to ≤ ep. 300), multi-address per call, ≤ ~22 sampled epochs | free plan forbids JSON-RPC *batching*; multi-address in one call is fine |
| SOL balance timeline | `getSignaturesForAddress` (≤ 5k sigs) + Enhanced Transactions API `nativeBalanceChange` (≤ 1.5k txs replayed) | truncation surfaced in `meta.notes` |
| LST positions | same replay's `tokenBalanceChanges` for mSOL / jitoSOL / bSOL / INF | rates: Marinade API (mSOL) + Sanctum sol-value; history back-compounded at benchmark yield |
| Benchmark ("fully staked" + "with Marinade" lines) | `apy.marinade.finance/v1/rolling-apy/liquid-token/mSOL` (case-sensitive path) | fallback: 7% |
| Cache | `cache/<wallet>.json`, 6 h TTL + in-flight dedupe | `?force=1` bypasses |

The chart's optional teal dashed line ("Replace my staking with Marinade") replays the
wallet's actual stake-balance *flows* (deposits/withdrawals net of rewards) compounding
at the mSOL APY — same behavior, Marinade yield. `card.mndeDeltaSol` is the end delta.

### Throughput knobs (env — raise after a Helius plan upgrade)

`MAX_SIG_PAGES` (5), `MAX_ENHANCED_TX` (1500), `REWARD_SAMPLE_CALLS` (22),
`REWARD_CONCURRENCY` (2).

## Known approximations (PoC)

- Sampled-rewards fallback (uncrawled wallets) misses pre-merge/split lineage; the
  Marinade-report path does not.
- Post-crawl stake flows are absorbed as a constant anchor at the crawl-boundary epoch
  (noted in the UI when > 0.01 SOL).
- LST exchange-rate history is back-compounded from the current rate at the benchmark
  yield, not fetched per epoch.
- Replay caps (see knobs above) — hyperactive wallets get a flat early-history
  approximation (noted in the UI).
- The Node fetch goes through the sandbox egress proxy via `undici@6` `EnvHttpProxyAgent`
  (undici v8 needs Node ≥ 22; sandbox runs Node 20).

## Related

- Shareable mock-only artifact (CSP forbids external fetches, so it stays simulated):
  https://claude.ai/code/artifact/91efe4ff-a55b-400b-9edf-6e192b9340e0
- Data-sourcing assessment: see conversation notes — Helius archival + Marinade
  staking-rewards API were selected over Solscan CSV (manual, 1k rows) and Orb (no API).
