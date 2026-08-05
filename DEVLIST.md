# Dev list

## Fixed (2026-08-05)

- [x] **GUI mojibake** (`ðŸ` everywhere) — static server sent UTF-8 with no charset, so the
      browser guessed latin-1. Added `charset=utf-8` to the server's content types *and*
      `<meta charset="utf-8">` to the page (so it's right on Vercel/file:// too).
- [x] **Panels clipped off the right edge** — `.dock` was hard-coded to 3 columns but now has 5
      panels. Now `repeat(auto-fit,minmax(290px,1fr))`, so it wraps at any width.
- [x] **Hits didn't match the fighters on screen** — the engine pairs opponents pseudo-randomly,
      but the client steered each circle at its *nearest* enemy, so damage numbers popped between
      circles that weren't fighting. Circles now chase the opponent the engine has them trading
      with next (`retarget()` looks ahead in the hit log).
- [x] **Rounds ran the full 60s even after a side was wiped** — the sim stops early but the clock
      didn't. `simulateRound` now returns `endTick`; the round closes shortly after the last hit.
      Verified: a round whose fight ended at 10s now settles at 12.7s instead of 60s.
- [x] **Confusing Phantom "not enough SOL" failure** — now detects the simulate/insufficient
      error and says plainly that Phantom is on the wrong network, naming the RPC to use.
- [x] **No way to get test funds** — added a one-click **🎁 Get test SOL + 500 BULL + 500 UWU**
      button (engine airdrops SOL for fees and mints both tokens), a SOL balance readout, and a
      copyable RPC URL with Phantom setup steps.

- [x] **Phantom network** — answer is Phantom → Developer Settings → **Testnet Mode ON** +
      **Solana Localnet** (its built-in `http://localhost:8899`). No custom RPC needed. Verified
      the validator answers POST with extension-friendly CORS on both `127.0.0.1` and `localhost`.
      ("Used HTTP Method is not allowed" is just the RPC rejecting a browser GET — harmless.)

## Open

- [ ] **Public devnet demo.** Still blocked: the devnet faucet rate-limits this machine, so the
      vault can't be funded there and the mints can't be recreated on public devnet. Localnet
      works fully in the meantime.
- [ ] **Trustless custody (Anchor vault).** `programs/vault/src/lib.rs` is written but not
      deployed — needs a C toolchain in WSL (`sudo apt install -y build-essential`), which needs
      the user's password. Custody is currently an engine-held keypair: fine for devnet,
      **must be replaced before real money**.
- [ ] **Public demo.** Re-create mints against public devnet + host engine/frontend
      (needs ~0.05 devnet SOL in the vault).
- [ ] Lobby currently shows bots only until a real player deploys; consider showing pending
      entries live during the lobby.

## 2026-08-05 — Phantom vs localnet

- [x] **Phantom blocks every localnet transaction.** It simulates transactions on Phantom's own
      servers, which cannot reach a validator on your machine — so it reports "Failed to simulate
      the results of this request", shows a 0 SOL fee, and refuses to proceed. Nothing was
      misconfigured; this is a hard limitation of Phantom + localhost.
      **Fix:** added a **dev wallet** — a burner keypair kept in the browser that signs locally
      and submits straight to the game's RPC. One click also auto-funds it with SOL + both
      tokens. Phantom stays supported (and is now sign-only, with the page submitting the tx)
      for when we move to public devnet.

## 2026-08-05 (later) — gameplay/readability pass

- [x] **Auto-deploy did nothing online.** It lived in the local-sim `startLobby()`, which never
      runs when the engine owns the lobby. Now fires from the lobby state message, once a round.
- [x] **Damage numbers looked random.** The sim re-paired every fighter each 500ms tick, so no
      one could reach their opponent and hits fired on a timer regardless of the screen. Fighters
      now lock into **duels** for 8 ticks (~4s): 82% of consecutive hits keep the same opponent
      (was ~0%). The client verifier was updated identically and still reproduces the engine.
- [x] **Only losses were shown.** Now the defender shows `-amount` and the raider `+amount`.
- [x] **Empty arena between rounds** (looked like extraction "wasn't running"). The lobby now
      broadcasts its entries and the client shows fighters gathering.
- [x] **P&L was wrong** — cost basis was zero online, so profit looked like your whole balance.
      The engine now tracks real on-chain `depIn`/`wOut`; P&L = balance + withdrawn − deposited.
- [x] **Player missing from the leaderboard.** The engine owns the board now and always includes
      real players with their true rank, even outside the top 12.
- [x] **Community growth.** Population starts at 12 and grows ~0.5/round up to 60, throttling
      down as real players join; broke wallets bust out, newcomers arrive (a third as raw
      addresses). Round settle reports joined/busted and the client announces them.

## 2026-08-05 (later still) - collisions decide hits again

The complaint "everyone takes ticks of damage every second" had a structural cause, not a
tuning one. In the prototype the browser WAS the game: a hit happened because two circles
collided. Going server-authoritative dropped physics entirely (it can't be reproduced across
machines), so the engine decided hits on a fixed schedule and the client animated around an
already-decided result - damage rained on everyone with nothing on screen causing it.

- [x] **Deterministic physics moved into the sim itself.** `engine/src/game.ts` now runs
      movement, wall bounces, circle collisions and the prototype's per-pair 430ms hit cooldown
      on a fixed 50ms timestep, seeded from the round seed. A hit happens because two fighters
      actually collided.
- [x] **The browser runs that same sim.** It no longer replays a hit log; it recreates the round
      from the revealed seed and renders its own simulation, so what you watch IS the
      authoritative fight. Verified: 846/846 hits, winner and settlement identical to the engine
      in both modes, and re-running a seed reproduces it exactly.
- [x] Virtual arena is fixed at 900x560 in the sim and scaled to whatever the canvas is, so the
      result never depends on window size.

## 2026-08-05 - balance, scale and stats

- [x] **Tiny fighters were unkillable.** Damage is capped at 25% of the *defender's* ring, so a
      $2.62 fighter only ever lost ~$0.65 a hit while raiding back just as much - it could farm
      two big fighters forever. Added a finisher: once you're below 12% of your attacker's size
      the cap lifts. Verified on the exact case - the tiny fighter now dies at 8.8s instead of
      surviving 60s, while an even 50v50 still goes the full distance (size-neutrality intact).
- [x] **Multiple deposits spawned multiple "YOU" fighters.** Topping up now adds to your existing
      fighter (3x$20 -> one fighter at $59.88 after fees).
- [x] **More active accounts** - population starts at 22, grows 0.7/round to 90, and wallets skip
      only 25% of rounds instead of 60%. Live rounds went from ~6-9 fighters to 17+.
- [x] **House take was wrong** - it was computed as 0.2% of *damage* off a local counter that
      never ran online. The engine tracks the real skim taken on every deploy; now reads exactly
      0.200% of deployed.
- [x] **Leaderboard / profile stats were all zero** - the engine sent only current value. It now
      sends dep, ret, raided and best per account, so P&L, raided and win rate populate.
- [x] **100 v 100 stress test**: 48,602 hits, 2.4s to compute a 60s round, value conserved
      exactly, ~2ms per tick in the browser (needs <50ms for realtime). It exposed a real
      problem - the hit log was **3.3 MB per round**. Since the browser recomputes the fight from
      the seed it never needed the log: roundStart now ships a hit *count* (2.5 KB payload) and
      the verifier proves fairness from its own recomputation plus the settlement.

## Not doing (yet)

- Projectile visuals (fighters shooting little projectiles at their target instead of contact
  damage). Noted as a nice-to-have; current collision model already drives hits.

## 2026-08-05 - persistence, stakes, and a data-integrity bug

- [x] **Restarting the engine wiped every player's balance.** The ledger was in memory only, so a
      crash or redeploy erased what players were owed while their tokens sat in the vault. This is
      what happened mid-session. `engine/src/store.ts` now snapshots the ledger to
      `engine/data/ledger.json` (debounced, atomic rename) and restores on boot; verified a
      deposit of $250 survives a hard kill.
- [x] **Multiple engines were running at once.** `wss.on("error")` swallowed EADDRINUSE, so failed
      instances kept running and several engines wrote the same ledger file, clobbering each
      other. The engine now exits loudly on a taken port.
- [x] **Free-form entry amount** - number box + slider + Max button, $1-$100, alongside the
      presets. The $100 cap is now enforced per side per round, so topping up cannot exceed it
      (verified: $70 then $70 -> second accepted at $30, total exactly $100).
- [x] **Banked shows per token** in the HUD and the fighter profile - you bank whatever you
      raided, which is mostly the enemy's coin, so a single total was misleading.

## Balance status (after the fairness fixes)

- Extraction: every stake size, side and position within about +/-1.7% ROI. No dominant play.
- Normal: sizes within about +/-8% (small/medium slightly ahead, minnows worst), but joining the
  **favourite side is still worth roughly +6-8% vs -8-11%** for the underdog. Fix this in the
  lobby (deploy caps / matchmaking) - a damage handicap was tried and made it far worse.
- House edge measures exactly 0.200% of deploys in every run.

## Bankroll study (`npm run strategy`) - 2026-08-05

8 strategies x 120 rounds x 14 players, $500 start, both modes.

### EXTRACTION: balanced. No strategy beats another.
Every style lands within about +/-1% per-round ROI and finishes near $500. Flat, %-of-bankroll,
all-in, favourite-chasing - all the same. This mode is done.

### NORMAL: two dominant metas remain.

| strategy | median end | ended up | per-round ROI |
|---|---|---|---|
| flat $25 on the FAVOURITE side | $990 | **14/14** | **+15.98%** |
| flat $25 (random side) | $807 | 12/14 | +9.05% |
| 5% of bankroll | $603 | 12/14 | +4.49% |
| flat $5 | $424 | 1/14 | -15.69% |
| 25% of bankroll | $5 | 0/14 | -8.62% |
| flat $100 (max) | $1 | 0/14 (14 busted) | -14.01% |
| all-in | $1 | 0/14 (13 busted) | -13.38% |

1. **Side-chasing is a solved game.** Joining the heavier side won for *every single player*,
   roughly doubling the bankroll in 120 rounds. That is not a choice, it is the correct answer.
2. **Stake size is not a preference either.** Mid stakes ($25) compound; the maximum stake
   ($100) busted 14/14. A whale is swarmed: each clash is capped at a share of the *smaller*
   position, so it can only ever win small amounts back, while many small opponents keep taking
   bites. Big play is structurally punished, small play ($5) bleeds to the fee.

### Recommended fixes (Normal only)
- **Balance sides in the lobby, not in damage.** Cap a deploy that would push your side's total
  more than ~15-20% above the other, or close the heavy side once the gap opens. A damage
  handicap was tried and swung it to underdog +64%/favourite -49%.
- **Cap aggregate damage per round per fighter** (e.g. a fighter cannot lose more than ~40% of
  its deployed stake in one round) so a whale can't be nibbled to death by a swarm.
- Re-run `npm run strategy` after each change; target is every row within a few % like Extraction.

## 2026-08-05 - the fairness structure (bounded exposure)

**The problem, stated properly:** a fighter's exposure scaled with *how many enemies it faced*,
not with its stake. A whale met 9 opponents, took 9 streams of damage, and could only win small
amounts back from each (per-clash caps are a share of the smaller position) - so max stakes
busted 14/14. And because value flowed toward whichever side was stronger, side-chasing paid
+16%/round and won for 14/14 players.

**The structure adopted: bounded exposure per fighter.**
- `MAX_LOSS = 0.5` - a fighter can lose at most 50% of its OWN deposited stake in a round, then
  it retires and keeps the rest. Downside is set by your stake, not by the crowd.
- `MAX_GAIN = 2.0` - a loose ceiling on winnings (a 3x round is still possible) so a small stake
  can't compound uncapped while risking the same 50%.
- Clash damage stays collision-driven, zero-sum and capped by the smaller position.

| metric | before | after |
|---|---|---|
| max-stake players busting | 14/14 | **0** |
| favourite side ROI | +6..8% (14/14 won) | **-1.5%** |
| underdog side ROI | -8..11% | +1.5% |
| bull vs uwu | - | -0.01% / -0.38% |
| stake spread (Normal) | -26% .. +293% | -2.9% .. +9.8% |
| house edge | 0.200% | 0.200% |

Verified live: seed commit, hit count, settlement, value conservation and the 50% cap all hold
in both modes (10/10 checks).

**Still open:** a residual gradient favours small stakes (whale -2.9% vs minnow +9.8% in Normal).
Cause: total losses available in the pool are 50% of everyone's stakes, and a whale cannot
realise its 2x ceiling against opponents who can only shed half of much smaller positions.
Closing it fully means scaling clash size by the attacker's stake, which trades away some of the
small-player protection - a design call, not a bug.

- [x] Hall of Fame is now a **tab in the Leaderboard** (was a dashboard card), and legends are
      populated from the authoritative settlement so it fills up during online play.

## 2026-08-05 - matched book (the fairness structure we kept)

Capping wins/losses was rejected. The structure adopted instead:

- **Matched book.** Only the amount both sides can cover is at risk. Bulls put up $500 against
  $300 of unicorns -> $300 a side plays and the surplus $200 is refunded pro-rata to the bull
  players at settlement. Sides start exactly equal, so side choice cannot be an edge, and nobody
  is capped or has stake confiscated. Winnings stay uncapped; you can still lose your in-play stake.
- **SMALL_EDGE = 1.03** - the smaller fighter in a clash hits 3% harder. Deliberate: with wallets
  on auto-deploy the average stake shrinks over time, and if the small stakes left couldn't beat
  fresh larger deposits, liquidity would sit idle. 1.10 was tried first and Normal compounded it
  to +46% - far too strong.
- **Minimum entry is now $0.01** (was $1), free-form up to $100.

Extraction lands where we want it: whale -0.59%, big -0.08%, medium +0.09%, small +0.56%,
minnow +1.08% - a gentle gradient toward small, sides neutral (48/52). Normal stays high-variance
by design (it compounds in-ring); its small bucket swings with a 6% wipeout rate.

- [x] **Fighter IDs collided across sides.** Entries were keyed by wallet only, so deploying on
      BOTH sides overwrote one fighter in the settlement map and destroyed value (a live round
      showed $24 vanish). Entries are now keyed `wallet|side` and split back on settle.

## 2026-08-05 - micro stakes ($0.05 / $0.50 / $1)

**Bug found:** `dust` (knocked out) was a flat $1.20, so any entry at or below it never became a
live fighter - 0 out of 140 rounds saw a single hit. Those players paid the 0.2% fee and got the
stake straight back. The $0.01 minimum was meaningless. Fixed: dust is now 3% of your OWN
deposited stake (`DUST_FRAC`), floored at half a cent.

**But micro stakes are now heavily -EV**, because exposure still scales with how many opponents
you meet, not with your stake:

| stake | Normal ROI | Extraction ROI |
|---|---|---|
| $0.05 | -53.5% | -62.1% |
| $0.50 | -81.1% | -6.4% |
| $1 | -70.0% | -2.6% |
| $5 | -17.2% | +1.7% |
| $25 | +10.3% | -2.6% |
| $100 | -14.7% | -0.4% |

A $1 fighter meets a field of $5-$100 fighters; every clash risks 25% of its own ring and it is
wiped long before it can win anything back. Extraction is far gentler (raids bank out) but $0.05
still loses badly.

**Recommended next step: size-banded targeting.** Fighters should seek opponents of comparable
size rather than the nearest enemy, so a $1 stake mostly fights other small stakes and a whale
fights whales. That makes % returns comparable across sizes without capping anyone - and it is
also what makes the *matches* fair, which is the original goal. Not implemented yet.
