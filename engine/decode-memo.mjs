// Turn a round's on-chain memo back into English.
//
//   node decode-memo.mjs <tx-signature>          read it straight off mainnet
//   node decode-memo.mjs --raw 'BvU1|[{...}]'    decode a string you already have
//
// The memo is deliberately terse — every byte is transaction size, and size is cost — so this is
// the key. Format: BvU1|[ round, round, ... ] where each round is:
//
//   a  arena          "us-x" = UWU vs SOL, extraction   ("-n" = normal/mayhem)
//   r  round number
//   h  seed hash      the commitment PUBLISHED BEFORE deploys opened (first 16 hex)
//   s  seed           the seed REVEALED at fight start   (first 16 hex)
//   w  winner         "A" = slot A (side one), "B" = slot B (side two)
//   p  pot            total staked that round, USD
//   c  count          how many wallets played
//   f  fighters       [ id, side, staked, outA, outB ]   -- ALL FIGURES IN USD
//                       id      first 6 chars of the wallet, or "bN" for arena bot N
//                       side    0 = slot A, 1 = slot B
//                       staked  what they put in
//                       outA    what they walked out with denominated in slot A's token
//                       outB    ...and in slot B's token (raids TAKE the enemy's coin, so a
//                               winner leaves holding some of both)
//                       Their result is (outA + outB) - staked. Per round these sum to zero
//                       across all fighters, less the house fee — that is the conservation
//                       property the engine audits on every settle.
//
// h and s together are the point: anyone can confirm the seed we revealed matches the commitment we
// published before anyone deployed, timestamped by the chain so it cannot be back-dated.
const RPC = process.env.SOLANA_RPC
  || "https://mainnet.helius-rpc.com/?api-key=0d960ade-310e-41e1-842f-073257b3978d";

const ARENA = { "us-x": "UWU vs SOL · extraction", "us-n": "UWU vs SOL · mayhem",
                "au-x": "ANSEM vs UWU · extraction", "au-n": "ANSEM vs UWU · mayhem",
                "as-x": "ANSEM vs SOL · extraction", "as-n": "ANSEM vs SOL · mayhem" };
// slot A / slot B token names, per arena
const TOKENS = { us: ["UWU", "SOL"], au: ["ANSEM", "UWU"], as: ["ANSEM", "SOL"] };

async function fetchMemo(sig) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }] }) });
  const j = await r.json();
  if (!j.result) throw new Error("transaction not found");
  const ixs = j.result.transaction.message.instructions || [];
  const memo = ixs.find(i => i.program === "spl-memo" || String(i.programId).startsWith("MemoSq"));
  if (!memo) throw new Error("no memo instruction in that transaction");
  return { text: memo.parsed ?? memo.data, fee: j.result.meta.fee, slot: j.result.slot,
           at: j.result.blockTime };
}

function render(text, meta = {}) {
  if (!String(text).startsWith("BvU1|")) throw new Error("not a Bulls-vs-Unicorns memo");
  const rounds = JSON.parse(String(text).slice(5));
  for (const r of rounds) {
    const pair = String(r.a).split("-")[0];
    const [tokA, tokB] = TOKENS[pair] || ["A", "B"];
    console.log("=".repeat(70));
    console.log(`ROUND ${r.r}  ·  ${ARENA[r.a] || r.a}`);
    if (meta.at) console.log(`  settled       ${new Date(meta.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`);
    console.log(`  winner        ${r.w === "A" ? tokA : tokB} (slot ${r.w})`);
    console.log(`  pot           $${r.p}   across ${r.c} wallet(s)`);
    console.log(`  commitment    ${r.h}…   published BEFORE deploys opened`);
    console.log(`  revealed seed ${r.s}…   revealed at fight start`);
    if (meta.fee != null) console.log(`  anchor cost   ${meta.fee} lamports  ($${(meta.fee / 1e9 * 72.8).toFixed(6)})`);
    if (!r.f) { console.log("  (per-wallet detail omitted — round was too large for one memo)"); continue; }
    console.log("");
    console.log(`  ${"wallet".padEnd(10)}${"army".padEnd(8)}${"staked $".padStart(12)}${("$ in " + tokA).padStart(14)}${("$ in " + tokB).padStart(14)}${"net $".padStart(12)}`);
    let tIn = 0, tOut = 0;
    for (const [id, side, inTok, outA, outB] of r.f) {
      const sideName = side === 0 ? tokA : tokB;
      // every figure is USD; a fighter walks out holding BOTH tokens because raids take the
      // enemy's coin, so the result is the sum of the two exits against what went in
      const net = (outA + outB) - inTok;
      tIn += inTok; tOut += outA + outB;
      const tag = String(id).startsWith("b") ? `bot ${id.slice(1)}` : id;
      console.log(`  ${tag.padEnd(10)}${sideName.padEnd(8)}${inTok.toFixed(4).padStart(12)}${outA.toFixed(4).padStart(14)}${outB.toFixed(4).padStart(14)}${(net >= 0 ? "+" : "") + net.toFixed(4).padStart(11)}`);
    }
    console.log(`  ${"".padEnd(18)}${tIn.toFixed(4).padStart(12)}${(tOut).toFixed(4).padStart(28)}${((tOut - tIn) >= 0 ? "+" : "") + (tOut - tIn).toFixed(4).padStart(11)}`);
    console.log(`  (in vs out should differ only by the 0.2% house fee — that is conservation)`);
  }
  console.log("=".repeat(70));
}

const arg = process.argv[2];
if (!arg) { console.log("usage: node decode-memo.mjs <signature> | --raw '<memo text>'"); process.exit(1); }
if (arg === "--raw") { render(process.argv.slice(3).join(" ")); }
else fetchMemo(arg).then(m => render(m.text, m)).catch(e => { console.error("error:", e.message); process.exit(1); });
