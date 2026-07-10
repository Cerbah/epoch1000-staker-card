// Helius JSON-RPC + Enhanced API helpers.
// SOLANA_RPC_URL and HELIUS_API_KEY come from the environment (persistent sandbox env).

// Read lazily so the .env bootstrap (loaded first by server.js) is honored.
const RPC_URL = () => process.env.SOLANA_RPC_URL
  || (process.env.HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
const HELIUS_KEY = () => process.env.HELIUS_API_KEY;

let rpcId = 0;

export async function rpc(method, params, { retries = 2 } = {}) {
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
export async function enhancedTransactions(signatures, { concurrency = 4 } = {}) {
  const chunks = [];
  for (let i = 0; i < signatures.length; i += 100) chunks.push(signatures.slice(i, i + 100));
  const out = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      const my = next++;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY()}`, {
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
export async function signaturesForAddress(address, { maxPages = 5 } = {}) {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
