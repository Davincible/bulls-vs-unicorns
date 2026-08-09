# The round keeper

A long-running process that makes rounds of the on-chain arena happen **continuously**, instead of
when a human runs `admin-open-round.mjs`. It opens each round, hands it to an ER validator, fields
house fighters so the arena is never an empty room, draws the seed, ticks the fight, settles it,
brings it home, pauses long enough for a player to read the result, and opens the next one.

It also publishes `public/keeper-status.json`, which is the only thing that lets the front end tell
*"keeper running, next lobby in 0:08"* from *"keeper is down, no round is coming"*.

## The one thing to know about how it works

The main loop **re-derives all state from the chain on every pass** and then does the single next
thing:

```ts
while (running) {
  const state = await readChainState();   // arena + current round, always fresh
  await driveOneStep(state);              // the one next action, then return
}
```

So **recovery is not a special path, it is the only path**. A crash halfway through a round is
indistinguishable, to the next pass, from a fresh boot: both arrive with no beliefs and are told by
the chain what phase the round is in. There is no reconciliation routine to rot, and "the keeper
never acts from memory" is true by construction. Kill it mid-fight and start it again — it picks the
fight back up because the fight is on the chain, not in the process.

## Running it

```sh
cd er-demo
bun run scripts/keeper/keeper.ts                # runs until you stop it
bun run scripts/keeper/keeper.ts --rounds 3     # stops cleanly after 3 settled rounds
bun run scripts/keeper/keeper.ts --dry-run      # one full pass, sends nothing
```

`--dry-run` does everything except send: loads the operator and house keys, picks an ER validator,
reads the chain, runs the phase machine to a decision, writes the status file, prints what it *would*
have sent, and exits 0. It is the check to run after touching anything in here.

`Ctrl-C` (or `SIGTERM`) finishes the current step and stops. A second one exits immediately.

**Run one keeper at a time.** The status file is a single-writer resource — two keepers (or a dry run
alongside a live one) will take turns overwriting it with their own `startedAt` and `roundsCompleted`.
The write is atomic so nothing tears, and the live keeper reclaims the file on its next heartbeat, but
a page watching during that second sees the other process's numbers. Two keepers driving the same
arena would also both try to open round `counter + 1`; the loser gets `RoundOutOfOrder` and backs off,
so it is loud rather than dangerous, but it is not a supported way to run this.

It needs the arena authority's key at `.devnet/fork-payer.json` — `open_round` and `delegate_round`
are both `has_one = authority`, and the keeper refuses to start if that key is not the arena's
authority. It creates and funds its own house wallets at `.devnet/keeper-house-wallets.json` on first
boot; both paths are gitignored.

Devnet only, enforced by `assertDevnetUrl` on every endpoint including the ER validator's fqdn.

Every number it runs on is in `config.ts` with the argument for it, and the ones worth changing are
env-overridable (`KEEPER_RESULT_HOLD_SECONDS`, `KEEPER_DRAW_TIMEOUT_SECONDS`,
`KEEPER_HOUSE_FILL_LEAD_SECONDS`, …). The lobby length is **not** one of them: that is
`DEFAULT_LOBBY_SECONDS` in `src/chain/constants.ts`, which already argues the choice at length.

## What it costs

**Rent dominates, and it is never reclaimed.** Measured on devnet, a round PDA is 1,093 bytes and
holds **8,498,160 lamports (0.0084982 SOL)** of rent exemption, paid by the operator at `open_round`.
There is no instruction that closes a round account, so that lamport balance stays there forever —
`close_round` undelegates the account, it does not reclaim it.

Everything else is signatures at 5,000 lamports each. Per round the operator signs `open_round`,
`delegate_round`, `close_lobby_and_draw`, `resolve`, `close_round` — five — plus one `tick` per second
of fight (the keeper sends none when the cursor has no backlog, so this tracks the fight's real
length, up to the 120-second bell). Each house wallet signs one `enter` per round.

So a round with a 40-second fight costs the operator about:

```
  rent        8,498,160 lamports   (0.0084982 SOL, never reclaimed)
  signatures     225,000 lamports   ((5 + 40) x 5,000)
  ------------------------------------------------
  total       8,723,160 lamports   ~0.0087 SOL, of which 97% is rent
```

At roughly two minutes a round that is about **0.26 SOL an hour**, almost all of it rent. Fund the
fork payer accordingly, and read the per-round `operator spent` line in the log as a measured balance
delta rather than an estimate — it includes the rent.

House wallets are topped up from the operator to 0.01 SOL whenever they drop below 0.002 SOL. At one
signature per round that is thousands of rounds per top-up; nothing else leaves them, because this
program custodies no balances at all (`enter` *records* a stake, it does not move one).

## Reading the status file

Written to `er-demo/public/keeper-status.json`, served at `/keeper-status.json` by Vite dev, `vite
preview` and a production build alike. The shape and every rule about it live in
`src/v2/data/keeperStatus.ts`, which both this keeper and the browser import — one module, both ends.

It is written **atomically** (temp file in the same directory, then `rename`), so a browser polling it
never reads half a document.

The four fields that carry the meaning:

- **`keeper.heartbeatAt`** — rewritten every `heartbeatIntervalSeconds` whether or not anything
  happened, by a timer independent of the main loop. If `now - heartbeatAt > staleAfterSeconds`, the
  keeper is down. A status file outlives the process that wrote it, so this comparison is the only
  thing separating "this describes now" from "this describes the moment before the keeper died".
- **`keeper.stalledSince`** — the third state, and the reason the file is at schema 2. A keeper whose
  loop is failing every pass is still *alive*: it catches, records, backs off and retries, while the
  heartbeat timer keeps writing a fresh `heartbeatAt`. "Alive but not progressing" would otherwise read
  as perfectly healthy and the page would keep promising a round that nothing is going to run. After
  `STALL_AFTER_CONSECUTIVE_FAILURES` failed passes — about a minute, and a "failed pass" already
  contains four failed reads — the keeper says so, and `keeperCountdown` draws nothing. Cleared on the
  first clean pass. Note there is no `staleAfterSeconds` equivalent for it: the threshold is chosen on
  the keeper's side to mean "this is not a blip", precisely so a reader is never handed a countdown
  that flickers off and back on again.
- **`nextLobbyOpensAt`** — non-null **only** while the keeper is holding between rounds. Null during
  Lobby (the chain's own `lobby_closes_at` is the honest countdown there), and null during Drawing and
  Fight, because a VRF callback lands when it lands and a fight ends when it ends. There is no honest
  answer in those phases and the keeper refuses to publish a guess. It is **latched per round**: the
  first time promised for a round is the time that round keeps, so the countdown counts down instead
  of resetting, and it is never published beside a round that is not in a hold phase. Both of those
  are enforced in one pure function (`honestNextLobbyOpensAt`) with regression tests, because both
  were violated in a real run without anything throwing or failing to parse.
- **`round`** — the current round as the chain reports it, including through the result hold. It stays
  populated during the hold on purpose: `keeperCountdown` returns nothing when `round` is null, so
  clearing it would silently kill the "next lobby in 0:08" countdown.

`round.houseFighterCount` / `realFighterCount` split the lineup against `house.wallets`, which is the
keeper's bot disclosure. That list is a claim made by the same process that runs the bots — believable,
not verifiable. Registering the house wallets on the Arena account on-chain is the better design and
is planned separately.

The file is gitignored. Its **absence** is meaningful: a 404 is correctly read as "no keeper is
running here".

## Known holes, stated rather than hidden

- **`Phase::Drawing` has no exit in the program.** If the VRF callback never lands, no signer has an
  instruction left to send for that round — `abandon_round`'s own doc comment in `lib.rs` documents the
  hole and the shape of the eventual fix. The keeper will not wedge alongside it: after
  `DRAW_TIMEOUT_SECONDS` it logs loudly, records the round number in `keeper.wedgedRounds`, and opens
  the next round anyway (`open_round` only needs `round_counter + 1`, which has already moved past the
  stuck round). The stuck round stays delegated and its rent is never reclaimed; a late callback would
  move it to `Fight` with nobody watching, where a human can settle it by hand because `resolve` is
  permissionless.
- **`close_round` can be sent twice.** The undelegate commit reaches the base layer asynchronously, and
  the base-layer owner is the only signal that it has. The keeper waits `UNDELEGATE_WAIT_SECONDS` for
  it; if that overruns, the next pass sees a Settled round still owned by the Delegation Program and
  re-sends. It costs a signature. This is the one duplicate transaction the design can produce, and it
  is the price of never having a "did I already send this?" flag that could get out of step with the
  chain.
- **Rounds can be stranded in `Lobby` by anything else that opens one.** If another process calls
  `open_round` (a verification script, a second operator), `arena.round_counter` moves past the round
  this keeper was running, and the keeper — correctly — follows the counter rather than its own memory.
  The round it was on is then unreachable by the phase machine, and sits delegated, past its deadline,
  holding ~0.0085 SOL of rent forever. **Not yet handled.** The fix is a bounded sweeper: on idle
  passes, look back a fixed number of rounds (say 20), and `abandon_round` any that is provably
  abandonable — phase `Lobby`, past its deadline with the skew margin, fewer than two fighters, and
  still owned by the Delegation Program, which is exactly `lobbyIsDead` plus the delegation
  precondition the live path already checks. At most one per pass, so a backlog drains gradually and
  never competes with the round being played; bounded, so it can never become a scan of the whole
  history on a 1Hz loop; and `Drawing` rounds are explicitly *not* sweepable, because the program has
  no exit for them. Until it exists, clean these up with `scripts/admin-abandon-round.mjs`.
- **Sends are not retried, deliberately.** Reads are (bounded backoff, in `chainClient.ts`); sends are
  not, because a blind retry can double-submit a transaction whose confirmation merely timed out — and
  a duplicate `enter` *tops up* a fighter rather than failing. The loop re-deriving from the chain is a
  strictly better retry: it looks at what actually happened before deciding what to do next.
