#!/usr/bin/env python3
"""Generate docs/ static build (GitHub Pages) from lib/ + public/index.html.
The pipeline runs fully client-side; the Helius key is embedded (team decision)."""
import re, os, sys

key = os.environ.get("HELIUS_API_KEY", "")
if not key:
    sys.exit("HELIUS_API_KEY not set")

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)

def load(f):
    return open("lib/" + f).read()

def strip_module(src):
    src = re.sub(r"^import .*$", "", src, flags=re.M)
    src = re.sub(r"^export ", "", src, flags=re.M)
    return src

rpc = strip_module(load("rpc.js"))
rpc = rpc.replace(
    "const RPC_URL = () => process.env.SOLANA_RPC_URL\n  || (process.env.HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);",
    "const RPC_URL = () => 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;")
rpc = rpc.replace("const HELIUS_KEY = () => process.env.HELIUS_API_KEY;", "")
rpc = rpc.replace("${HELIUS_KEY()}", "${HELIUS_KEY}")
assert "process.env" not in rpc

lst = strip_module(load("lst.js"))
lst = re.sub(
    r"const REGISTRY = JSON\.parse\(readFileSync\((?:.|\n)*?'utf8'\)\);\n",
    "let REGISTRY = [];\nlet LST_MINTS = {};\nlet FALLBACK_RATES = {};\n"
    "async function ensureRegistry() {\n"
    "  if (REGISTRY.length) return;\n"
    "  REGISTRY = await (await fetch('./lst-mints.json')).json();\n"
    "  LST_MINTS = Object.fromEntries(REGISTRY.map((l) => [l.mint, { symbol: l.symbol, decimals: l.decimals }]));\n"
    "  FALLBACK_RATES = Object.fromEntries(REGISTRY.map((l) => [l.symbol, l.fallbackRate]));\n"
    "}\n", lst)
lst = re.sub(r"const LST_MINTS = Object\.fromEntries\(\s*REGISTRY\.map[^;]*;\n", "", lst)
lst = re.sub(r"const FALLBACK_RATES = Object\.fromEntries\(REGISTRY[^;]*;\n", "", lst)
assert "readFileSync" not in lst and "ensureRegistry" in lst

bench = strip_module(load("benchmark.js"))
mar = strip_module(load("marinade.js"))
pipe = strip_module(load("pipeline.js"))
for var in ["MAX_SIG_PAGES", "MAX_ENHANCED_TX", "REWARD_SAMPLE_CALLS", "REWARD_CONCURRENCY"]:
    pipe = re.sub(r"Number\(process\.env\.%s \?\? (\d+)\)" % var, r"\1", pipe)
# marinade.js already declares these at what becomes shared scope
pipe = pipe.replace("const SLOTS_PER_EPOCH = 432_000;\n", "").replace("const LAMPORTS = 1e9;\n", "")
assert "process.env" not in pipe and "process.env" not in lst

header = ("// epoch1000 staker card — static browser build (GitHub Pages, no server).\n"
          "// The whole pipeline runs client-side: Helius RPC + Enhanced API, Marinade\n"
          "// staking-rewards / APY APIs, Sanctum rates (all CORS-open, verified 2026-07-10).\n"
          "// The Helius key below is intentionally public (team decision).\n"
          "'use strict';\n"
          "const HELIUS_KEY = '" + key + "';\n")

wrapper = """
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
"""

app = "\n".join([header, "/* -- rpc -- */", rpc, "/* -- lst -- */", lst,
                 "/* -- benchmark -- */", bench, "/* -- marinade -- */", mar,
                 "/* -- pipeline -- */", pipe, wrapper])
os.makedirs("docs", exist_ok=True)
open("docs/app.js", "w").write(app)

# ---- index.html: swap server calls for the in-browser pipeline ----
html = open("public/index.html").read()
old = """    if(forceSim)throw {sim:true};
    const r=await fetch('/api/report?wallet='+encodeURIComponent(addr));
    if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||('HTTP '+r.status));
    render(await r.json());"""
new = """    if(forceSim)throw {sim:true};
    render(await window.buildReportLive(addr));"""
assert old in html
html = html.replace(old, new, 1)
old_ep = """  try{
    const r=await fetch('/api/epoch');
    if(r.ok)epochState={...await r.json(),localT:Date.now()};
  }catch(_){/* keep last state */}"""
new_ep = """  try{
    epochState={...await window.epochInfoLive(),localT:Date.now()};
  }catch(_){/* keep last state */}"""
assert old_ep in html
html = html.replace(old_ep, new_ep, 1)
html = html.replace("</head>", '<script src="./app.js"></script>\n</head>', 1)
html = html.replace("'Live lookup failed ('+(e.message||e)+') — showing a simulated profile instead.'",
                    "'Live lookup failed ('+(e.message||e)+') — showing a simulated profile instead. Retry in a minute (public RPC limits).'")
open("docs/index.html", "w").write(html)

import shutil
shutil.copy("lib/lst-mints.json", "docs/lst-mints.json")
open("docs/.nojekyll", "w").write("")
print("docs/ built: app.js %d bytes, index.html %d bytes" % (len(app), len(html)))
