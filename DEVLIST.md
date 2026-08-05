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
