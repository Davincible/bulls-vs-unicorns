// Watch a live engine over the wire and report what actually happens in its rounds.
//
// The money-destroying bug shipped green and was only caught by looking at a running system, so
// this exists to make "is it really working" a command rather than a guess. It joins as a spectator,
// follows N settled rounds, and prints who entered, what was staked, and who won.
//
//   node observe.mjs [wss://host] [rounds]
import WebSocket from "ws";

const URL = process.argv[2] || "wss://bulls-arena-engine.fly.dev";
const WANT = Number(process.argv[3] || 5);
const TIMEOUT_MIN = Number(process.env.OBSERVE_TIMEOUT_MIN || 6);

const ws = new WebSocket(URL);
const t0 = Date.now();
let settled = 0, botEntries = 0, humanEntries = 0, staked = 0;
const seen = new Map(); // arena -> last round no, to catch a stalled arena

const bail = (msg, code) => { console.log(msg); try { ws.close(); } catch {} process.exit(code); };
const n2 = (x) => Number(x || 0).toFixed(2);

ws.on("open", () => console.log(`connected ${URL} — following ${WANT} settled round(s)\n`));

ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }

  if (m.t === "chain") {
    console.log(`chain ready=${m.ready} vault=${m.vault || "-"}\n`);
    return;
  }

  // roundStart carries the full entry list, which is where bot money becomes visible
  if (m.t === "roundStart" || m.t === "roundStartN") {
    const es = m.entries || [];
    const bots = es.filter(e => e.bot).length;
    const stake = es.reduce((s, e) => s + (e.stake || 0), 0);
    botEntries += bots; humanEntries += es.length - bots; staked += stake;
    seen.set(m.arena, m.round);
    console.log(`  ${m.arena} r${m.round} start — ${es.length} entries (${bots} bot, ${es.length - bots} human), stake ${n2(stake)}${m.resumed ? " [resumed]" : ""}`);
    return;
  }

  if (m.t === "settled") {
    settled++;
    console.log(`  ${m.arena || ""} settled — winner ${m.winner ?? "?"}`);
    if (settled >= WANT) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`\n${settled} rounds in ${mins} min`);
      console.log(`entries: ${botEntries} bot, ${humanEntries} human — total stake ${n2(staked)}`);
      if (botEntries === 0) bail("\nFAIL — no bot ever entered. The pool has no usable float.", 1);
      bail("OK", 0);
    }
  }
});

ws.on("error", (e) => bail(`socket error: ${e.message}`, 1));
ws.on("close", () => bail(`\nclosed after ${settled} settled round(s)`, settled >= WANT ? 0 : 1));

// A stalled engine is the failure that matters most: it looks alive on /health and settles nothing.
setTimeout(() => bail(`\nTIMEOUT — only ${settled} settled round(s) in ${TIMEOUT_MIN} min. Engine is not settling.`, 1),
           TIMEOUT_MIN * 60_000);
