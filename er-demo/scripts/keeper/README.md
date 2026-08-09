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
bun run scripts/keeper/keeper.ts --hold-open    # hold ONE lobby open for players (see below)
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

## Two lobby policies

**Fixed cadence (the default).** A fresh `DEFAULT_LOBBY_SECONDS` lobby every round, ended by its own
deadline. Every round permanently locks the round PDA's rent whether or not anybody played, and every
one of those fights is the house against itself.

**Hold open (`--hold-open`, or `KEEPER_HOLD_OPEN=1`).** One lobby, opened with a long *backstop*
deadline and held until a real player arrives:

```
open ONE round, backstop deadline HOLD_OPEN_LOBBY_SECONDS away
ONE house fighter goes in, so the room is not an empty page
hold ─────────────────────────────  nothing sent, nothing spent, for as long as it takes
first REAL player enters  →  house fills in around them  →  20s grace  →  authority close  →  fight
```

One rent payment instead of one per cycle, and the fight starts because a person showed up.

**Exactly one house fighter while holding, and that number is the load-bearing part.** At one fighter
`enough_to_fight` fails, so `close_lobby_and_draw` is refused *for everyone* — not just for a keeper
that declines to call it, but for a permissionless caller racing us at the deadline. "No
house-versus-house fights" stops being a policy and becomes something the program enforces. It also
keeps `lobby_is_dead` true, so a held lobby nobody joined can still be **abandoned** at its backstop
and the round always reaches a terminal state. Seeding the usual four would have inverted both: the
lobby could be drawn by anyone the moment the deadline passed, and it could never be abandoned.

**It is off by default and it is not auto-detected.** The policy needs the authority-signed early
close in `close_lobby_and_draw`, which exists in `lib.rs` and **is not deployed**. The only local
evidence is the IDL, which is generated from *source* and can be regenerated before a deploy — so a
capability probe would turn "somebody edited Rust" into "the chain will accept this". Whether a
program is deployed is not a question this process can answer. The operator turns it on.

The IDL still gets a **veto**, because it can prove the negative: if `close_lobby_and_draw` has no
`authority` account, `--hold-open` refuses to start. Measured, not assumed — built both ways against
the served IDL and the account lists are byte-identical, so the extra account is dropped silently and
every early close would come back as `LobbyStillOpen` (an error about the *clock*) with a real player
standing in the lobby.

**Real vs house is a private list.** Anyone not in the keeper's own house-wallet set counts as real.
There is deliberately no on-chain registry and no flag on the round — that is an operator decision,
not a gap to be tidied up.

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

**Reconciled across 28 real rounds the all-in figure is 0.00981 SOL per round** (net of a one-time
0.06 SOL house-wallet funding), of which `open_round`'s 0.008503160 SOL is permanent and
`delegate_round`'s 0.003220520 SOL comes back when undelegation closes the delegation accounts. That
every round PDA keeps its deposit forever is verified rather than inferred: rounds #4 to #18 all still
hold exactly 0.008498 SOL.

**This is the entire argument for `--hold-open`**, and it is the reason the backstop is an hour:

| policy | idle cost |
|---|---|
| cycling every ~110s | ~0.32 SOL/hour |
| 1-hour holds | ~0.0098 SOL/hour — **97% of the saving** |
| 1-day holds | ~0.0004 SOL/hour |
| 7-day holds | ~0.00006 SOL/hour |

`MAX_LOBBY_SECONDS` is a week, and the keeper deliberately does not take it. Its own doc comment in
`lib.rs` says plainly that nothing has ever verified a round can *stay delegated* that long — the
longest this repo has exercised is a couple of minutes, and `MAGICBLOCK_FEEDBACK.md` records ER
validators losing state. The two failures are not the same size: too short costs one 0.0098 SOL rent
payment an hour, visible in the log; too long fails as a silently dead arena nobody notices. Raising
it is a one-line change in `config.ts` and wants one piece of evidence — a delegation *observed*
surviving longer, not reasoned about.

House wallets are topped up from the operator to 0.01 SOL whenever they drop below 0.002 SOL. At one
signature per round that is thousands of rounds per top-up; nothing else leaves them, because this
program custodies no balances at all (`enter` *records* a stake, it does not move one).

## Reading the status file

Written to `er-demo/public/keeper-status.json`, served at `/keeper-status.json` by Vite dev, `vite
preview` and a production build alike. The shape and every rule about it live in
`src/v2/data/keeperStatus.ts`, which both this keeper and the browser import — one module, both ends.

It is written **atomically** (temp file in the same directory, then `rename`), so a browser polling it
never reads half a document.

**Schema 3.** `parseKeeperStatus` requires an exact match, so an older page against this keeper reads
as "keeper down" rather than as a status it half-understands. That degradation is the point: a v2 file
has no way to say "this deadline is a backstop", so defaulting the missing fields would put a
59:47 countdown on a lobby that is being held open — the confidently-wrong number the whole module
exists to prevent.

The six fields that carry the meaning:

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
- **`round.heldOpen`** — true while the lobby is open with **zero real fighters** and the keeper is
  going to close it itself when somebody arrives. Its whole job is to *stop* a countdown:
  `lobbyClosesAt` is an hour of backstop, and the only thing that happens at it is the keeper
  abandoning this round and opening another, so a countdown to it would be a countdown to a non-event.
  `keeperCountdown` answers `waiting-for-players` here — a state with no `seconds`, because none
  exists.
- **`entriesCloseAt`** — the instant the keeper **intends** to stop taking entries. Non-null only once
  a real player has entered and the grace window is running; null throughout a held-open lobby,
  because the keeper is not waiting for a clock, it is waiting for a person. Deliberately *not* the
  chain's `lobbyClosesAt`: that is the backstop the program enforces, this is the schedule the keeper
  is about to act on, and while somebody is standing in the lobby the two differ by an hour. Once it
  is set it is the **only** answer for that lobby — including after it passes, where the countdown
  stops rather than falling back to the backstop.
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
- **The house sweep is best-effort within the round's own hold.** After `close_round`'s undelegation
  *confirms* — the round has to be back on the base layer, or `Account<'info, Round>` fails the owner
  check before any phase guard is reached — the keeper sends `sweep_house_take` to move that round's
  `fees_collected` + `penalties_collected` onto the arena's `Treasury`, creating the treasury with
  `init_treasury` first if it does not exist. It is derived from `Round.house_swept` rather than
  remembered, so retries are free and a double sweep is refused by the program. Every failure is
  caught and recorded rather than thrown: this is bookkeeping, and a keeper that stopped running
  rounds because a ledger update failed would be trading the product for its own accounting. A round
  that misses its hold keeps its take *on the round account*, where it stays readable and stays
  sweepable — the instruction is permissionless, so anyone can finish it later. What that costs until
  somebody does is a gap between `Treasury.rounds_swept` and the arena's `round_counter`.
- **No cumulative treasury figure is published, and that is a refusal rather than an omission.** A fee
  paid by a house wallet is a wash — bot wallet to treasury, same owner — and `DEVLOG.md` Bug #20 is
  this mistake already made once, with the off-chain engine's books "growing" while zero real players
  were on. Splitting real from circular revenue needs the fee attributed *per wallet*, and chain state
  cannot do it: `Round` stores each fighter's stake **net** and the fee only in aggregate, so the
  gross a particular wallet paid survives solely in the `Entered` event. The arithmetic inverse is not
  exact against the program's flooring. So the status file carries no total, and the sweep's log line
  prints the amounts beside the round's real/house composition instead — a round with no real fighters
  says in words that all of it is the house paying itself.
- **Sends are not retried, deliberately.** Reads are (bounded backoff, in `chainClient.ts`); sends are
  not, because a blind retry can double-submit a transaction whose confirmation merely timed out — and
  a duplicate `enter` *tops up* a fighter rather than failing. The loop re-deriving from the chain is a
  strictly better retry: it looks at what actually happened before deciding what to do next.
