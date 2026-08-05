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
