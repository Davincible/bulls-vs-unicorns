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
bun run scripts/keeper/keeper.ts --no-close-rounds   # stop reclaiming finished rounds' rent
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
boot; both paths are gitignored. Both can instead come from the environment (`KEEPER_OPERATOR_KEY`,
`KEEPER_HOUSE_WALLETS`), which is how a deployment gets them — env beats file, and the boot log says
which won without ever printing the keys. See **Deploying it**.

It also serves its status over HTTP on `KEEPER_HTTP_PORT` (default 8080) while it runs — locally that
is redundant with the file, and in production it is the only channel that works. A port it cannot bind
is logged loudly and does **not** stop the keeper: rounds matter more than telemetry.

Devnet only, enforced by `assertDevnetUrl` on every endpoint including the ER validator's fqdn — and
including whatever `KEEPER_BASE_RPC` / `KEEPER_ROUTER_URL` supply, asserted at boot before any
connection is constructed.

Every number it runs on is in `config.ts` with the argument for it, and the ones worth changing are
env-overridable (`KEEPER_RESULT_HOLD_SECONDS`, `KEEPER_DRAW_TIMEOUT_SECONDS`,
`KEEPER_REAL_PLAYER_GRACE_SECONDS`, …). The lobby length is **not** one of them: that is
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
first REAL player enters  →  45s grace, house arriving through it  →  authority close  →  fight
```

One rent payment instead of one per cycle, and the fight starts because a person showed up.

**Exactly one house fighter while nobody real is in the room, and that number is the load-bearing
part.** At one fighter `enough_to_fight` fails, so `close_lobby_and_draw` is refused *for everyone* —
not just for a keeper that declines to call it, but for a permissionless caller racing us at the
deadline. "No house-versus-house fights" stops being a policy and becomes something the program
enforces. It also keeps `lobby_is_dead` true, so a lobby nobody joined can still be **abandoned** at
its deadline and the round always reaches a terminal state. Seeding the board's full complement would
have inverted both: the lobby could be drawn by anyone the moment the deadline passed, and it could
never be abandoned.

**This rule is no longer conditional on hold-open.** It used to live in the hold-open branch, so with
`KEEPER_HOLD_OPEN=0` the seed stage put two fighters into an empty room and the round fought itself at
its deadline — survivable at a board of four, and two and a half times the size at a board of ten. It
is now the first thing `houseFighterCount` answers, before any board policy is read, so it holds under
every configuration. See "The house's board" below.

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

**Real vs house is a private list, and it is now private in both directions.** Anyone not in the
keeper's own house-wallet set counts as real. There is deliberately no on-chain registry and no flag
on the round — that is an operator decision, not a gap to be tidied up.

> **Changed.** The set used to be private only in the sense that the chain did not know it: the keeper
> *published* it, in `keeper-status.json`, as a bot-disclosure list every browser could read, together
> with a per-round `houseFighterCount` / `realFighterCount` split. That is gone. The arena's own
> wallets are anonymous — not named, not listed, not counted anywhere a browser can reach. The
> classifier is unchanged and still runs on every pass, because the treasury rule is built on it; what
> changed is that its output no longer leaves the process by a public channel. One authenticated
> consumer remains: see [The roster endpoint](#the-roster-endpoint).

## The house's board

`MAX_FIGHTERS` is 48 (it was 16 when live rounds #23, #27 and #28 ran). Those rounds each ran **four**
fighters, two of them house — a quarter-full arena at that old cap, which is most of why the rounds
read as dead. The house now holds the board at ten.

```
nobody real in the room   1 house fighter    the treasury rule; the chain will not draw this round
1 real player             9 house            board of 10, split 5-5
2 real players            8 house            board of 10
5 real players            5 house            board of 10
10+ real players          0 house            the house is gone
```

One sentence: **the board stays at `KEEPER_HOUSE_BOARD_TARGET` fighters and turns human as people
arrive.** The house gives up one seat per real entrant, and `allocateHouseSides` places each fighter
on whichever side is currently smaller, so neither side is ever a queue.

### When they arrive, which is a separate question from how many

The house used to arrive in one step, twelve seconds before the draw. At the production board of 48
that meant a real player's arrival was followed about eight seconds later by forty-two fighters
appearing in a single frame — every one of them legitimate under the policy above, and all of them
together reading as a bot swarm rather than as a room.

They now arrive on a **schedule spread across the entry window**:

```
real player enters                                                        authority close
│                                                                                       │
├───────────────── KEEPER_REAL_PLAYER_GRACE_SECONDS (45s) ──────────────────────────────┤
├──────────── arrivals (40s) ─────────────┤─ KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS (5s) ────┤
▲   ▲▲    ▲        ▲   ▲▲▲  ▲      ▲   ▲▲▲▲
```

**The grace window is the only runway there is**, which is why it is now a knob of its own and why it
is 45 seconds rather than the 20 it borrowed from the chain's minimum lobby. A room with nobody real
in it holds exactly one house fighter (the treasury rule), so the house physically cannot trickle in
ahead of the first player — the room goes from one fighter to N *after* that moment, and the grace is
that moment to the bell. Peak demand is ~47 fighters, and a room filling faster than about 1.5
fighters a second stops reading as people arriving, so the window needs ~40 seconds plus a tail.

The honest price is that the first player waits 45 seconds instead of 20 — and they are not waiting at
nothing, they are watching the room fill around them, which is the thing being built. The other half
of the trade is that a second real player now gets 45 seconds to find the round instead of 20.

**The arrivals are derived, never random.** For each ordinal `k` the schedule takes a uniform draw
from the same deterministic hash `houseStake` uses, sorts them, and rescales so the first sits exactly
at the window's start and the last exactly at its end. That is not decoration:

- **it is a Poisson process, conditioned on its count.** N independent uniform points on a window,
  sorted, is *exactly* what a Poisson process looks like given that it produced N arrivals — so the
  gaps come out exponential, many short with the occasional long one. A metronome at one fighter every
  0.85 seconds would read as a machine just as clearly as the single burst did, only slower.
- **it is reproducible.** A round's lineup, its stakes and now its arrival order can all be
  re-derived from the round number alone, months later, after the accounts have been closed. It also
  means a retry after a failed send asks for the same thing the attempt it is retrying asked for —
  the keeper holds no memory and re-derives every decision from the chain each pass.
- **the rescale makes two things structural rather than likely.** The room starts filling the instant
  the player arrives, and the schedule provably cannot run past the window: by the end of it every
  fighter is due, so the board is whole by the time the lobby is drawn and a ramp can never cause a
  short board.

**Arrival order and stake size are independent**, deliberately. "Whales arrive late" is a real
phenomenon in markets with price discovery; this one has none — return is size- and seat-neutral
(`HOUSE-EDGE-STUDY.md` §0) — so simulating a behaviour whose cause does not exist is a fiction that
eventually reads as fake, and a correlation is a signature.

**Two things the schedule never throttles**, because they are about whether there is a round at all
rather than about how the room looks while it fills: the fightability floor (two fighters, one a side,
on the first pass a real player is seen — which is what makes the early close safe while the rest of
the house is still walking in) and the `cover` fighter that keeps a one-sided lobby drawable.

**What it traded away, honestly.** The old lateness was the mechanism that made *displacement* real: a
house that has already committed its whole roster has nothing left to give up when somebody arrives.
The ramp seats fighters earlier in the window than the step did, so some of that headroom is genuinely
gone. What is not gone is the guarantee — `REAL_SEATS_RESERVED` is applied to the house's ceiling on
every pass, and it is now larger than it was. Displacement was the aesthetic half of the policy; the
reservation is the invariant.

This reverses the previous policy, which is worth saying plainly. That one targeted four and displaced
*two*: the house was scaffolding that left entirely once two real players could fight each other, so
the board **shrank** as the arena got busier. `KEEPER_HOUSE_BOARD_TARGET=4` with
`KEEPER_HOUSE_DISPLACEMENT=2` restores it exactly, without a deploy.

### What it puts at risk, which is the part to argue with

`enter` records a stake; it never moves lamports. But `Treasury.fees_accrued` is, in
`sweep_house_take`'s own words, "a ledger the off-chain treasury is paid against", and the fight is a
zero-sum exchange over the recorded stakes. Conservation gives two bounds:

```
house profit on a round  <=  total REAL stake in it
house LOSS   on a round  <=  total HOUSE stake in it
```

and the house's expected revenue is `fee_bps` on **real** entries only — the fee its own wallets pay is
charged by the house to the house, which nets to nothing. Since `advance_fight` began reading
`min(ring_a, ring_d)`, return is size- and seat-neutral to within noise (`HOUSE-EDGE-STUDY.md` §0), so
expected P&L on the house's own seats is ~0 and what scales with the board is the **tail**, not the
edge.

That splits the problem, and the split is why the stake ceiling came *down* in the same change that
tripled the board:

- **seats** are what make the arena look alive. One signature each, no edge to anyone.
- **stake** is the entire downside tail, and buys nothing a seat did not already buy.

```
                       fighters   mean stake   house stake on the board
before  (1 real)          2         $27.50        ~$55
now     (1 real)          9         $12.50       ~$113     band narrowed to $5-$20
"full board, old band"    9         $27.50       ~$248     what raising the count alone would have cost
worst case now            9         $20          ~$180
```

Against a fee ledger entry of about **$0.20** on a $20 real entry at 1% — a counter, not cash, until
custody ships. The house is not paid for carrying this; it carries it to have an arena worth walking
into. If the edge study in flight says the tail is worth less than the liveliness,
`KEEPER_HOUSE_STAKE_MAX_USD=50` takes the old band back and roughly doubles the number.

**Two second-order effects a bigger board has, recorded so nobody has to rediscover them.**

*The extract penalty window gets longer in wall-clock terms.* `PENALTY_HORIZON_STEPS` is indexed by
`fighter_count` and `steps_per_second` is `2 x fighter_count`, so the time until extracting is free is
`horizon / (2n)` seconds:

```
4 fighters    200 steps /  8 steps/s  =  25.0 s
10 fighters   791 steps / 20 steps/s  =  39.6 s     +58%
```

Every fighter in a ten-handed round therefore pays the early-extract penalty for over half as long
again as they would have in a four-handed one. `HOUSE-STRATEGY.md` §4 puts the extract penalty at ~60%
of modelled revenue, so this is not a rounding effect — it is the largest economic consequence of the
board size after the exposure above, and it moves in the house's favour.

*It does **not** displace paying players here, though the same policy in a smaller room would.*
`HOUSE-STRATEGY.md` §2.1 measures net house revenue collapsing from $8.56 to $3.09 as the house takes
0 → 6 of **8** seats, "because six house seats mean two paying seats". That mechanism is seat scarcity,
and it does not bind in a forty-eight-seat arena holding a board of ten with nine seats reserved: a real
player is never turned away, so no house fighter is standing where a paying one would have. That
guarantee is `REAL_SEATS_RESERVED`, and it is the reason the reservation is an invariant rather than a
knob. Shrink the arena, or raise the board target far enough that the reservation starts binding, and
§2.1's collapse becomes the governing effect instead.

### Raising the wallet count

`KEEPER_HOUSE_WALLET_COUNT` is both the size of the bank and the ceiling on the roster — a policy that
asked for an eleventh fighter would be asking for a wallet that does not exist. On a deployment it is a
**two-step**, and `loadOrCreateHouseBank` refuses rather than guesses if you do only the first:

```
# 1. locally, where .devnet/ is writable. The bank is extended during boot, before the first pass, so
#    starting the keeper and stopping it once the banner has printed is enough. It EXTENDS the file —
#    every existing key keeps its index and its pubkey, so the classifier still reads the wallets that
#    fought earlier rounds as house rather than as visitors. Do NOT use --dry-run here: it generates in memory and
#    deliberately writes nothing, which is the opposite of what this step is for.
bun run scripts/keeper/keeper.ts     # Ctrl-C once the boot banner shows the new wallet count

# 2. re-issue the secret with ALL of them, then deploy
fly secrets set KEEPER_HOUSE_WALLETS="$(cat ../.devnet/keeper-house-wallets.json)"
```

Keys that arrive from the environment are never written back, so a container that generated the
shortfall itself would fund four wallets and lose them on every restart — while the classifier's set
changed underneath the rounds it describes, leaving the keeper reading its own previous wallets as
real players and fielding a full board into an empty room. The keeper throws with that arithmetic in
the message rather than doing it.

**The house must never be able to fill the room.** `REAL_SEATS_RESERVED` holds seats back against the
chain's own `fighters.length`, so a raised board target cannot hand an arriving player `RoundFull`. It
yields only to the `cover` fighter that makes a lopsided lobby drawable at all — an unenterable round
is bad, an undrawable one is worse.

It is **derived and deliberately not an env knob**: `max(4, ceil(4 x grace / 20s))`, which is **9** at
the default grace of 45 seconds. The estimate behind it has always been an *arrival rate* — four people
may turn up inside one grace window — so lengthening the grace without scaling it would have quietly
weakened a documented promise by exactly the factor the window grew by, with nothing failing to say so.
The floor of 4 keeps the old value as a minimum. At the production board of 48 seats the cost is that
the house holds at most 38 of them rather than 43: invisible on screen, and it buys back the promise
that a person who clicks Enter finds a seat.

## What it costs

**Rent dominates.** Measured on devnet, a round PDA is 1,093 bytes and holds **8,498,160 lamports
(0.0084982 SOL)** of rent exemption, paid by the operator at `open_round`. Note that `close_round`
*undelegates* an account, it does not reclaim one — the two are different instructions and the names
are close enough to mislead.

**It used to stay there forever. From v7 it does not:** `close_round_account` hands the deposit back,
and the keeper calls it automatically. Everything in this section is the cost *before* that — read it
as the standing cost of a round that is still inside the retention window, then read "Reclaiming the
rent" below for what a round costs once it leaves.

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

**The bigger board adds signatures and nothing else.** A house `enter` is one signature at 5,000
lamports, so going from two house fighters a round to nine costs **+0.000035 SOL per round that
actually fights** — under a tenth of the ~0.00041 SOL a round costs once `close_round_account` is
reclaiming rent. Rounds only complete when a real player turns up, so the daily figure tracks traffic
rather than the keeper: **+0.0035 SOL/day at 100 rounds, +0.035 SOL/day at 1,000**. The one-time cost
is parking `KEEPER_HOUSE_WALLET_TARGET_SOL` in four more wallets: **+0.04 SOL**, taking the bank from
0.06 to 0.10 SOL. At 0.01 SOL each and 5,000 lamports a round, a wallet reaches its 0.002 SOL refill
floor after ~1,600 rounds. None of this is the cost worth watching; the exposure above is.

**Reconciled across 28 real rounds the all-in figure is 0.00981 SOL per round** (net of a one-time
0.06 SOL house-wallet funding, now 0.10), of which `open_round`'s 0.008503160 SOL is permanent and
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

### Reclaiming the rent — the 22x

Everything above was written when nothing ever gave the rent back. **v7's `close_round_account`
does**, and the keeper calls it automatically:

```
per round, all-in                  0.008971 SOL
  of which Round-PDA rent          0.008561 SOL   95.4%, reclaimable from v7
marginal cost once reclaimed      ~0.00041  SOL   ~22x cheaper
```

On a payer holding ~6.6 SOL that is the difference between roughly **740 rounds and 16,200**. It is
the single largest cost in running the arena, and it was invisible precisely because nothing failed.

**On by default**, which is the opposite of `--hold-open` and worth saying why. Hold-open needed the
operator's say-so because its precondition — a *deployed* early close — is not a question any local
file can answer, and getting it wrong stranded a real player in a lobby. This has no such gap: every
condition is enforced *on chain* by `check_close_permitted` (terminal phase, `house_swept`, past the
retention window, authority-signed), so a keeper that asks for something it should not get is refused
rather than obeyed. The worst case is a wasted signature. Leaving money on the floor is not the safe
default; it is the expensive one.

Turn it off with `--no-close-rounds` or `KEEPER_CLOSE_ROUNDS=0` — for a demo or an audit that needs
the round log to outlive the retention window. It costs 0.0086 SOL per round to do that.

**The retention window is what makes it safe for the UI.** `useHistory` fetches rounds by address
with `fetchNullable` and its caller drops nulls, so a closed round leaves the log *silently* — no
error, no gap marker — and nothing in `src/` reads events, so there is no path that reconstructs it.
The chain guaranteeing the newest `MIN_RETAINED_ROUNDS` (20) rounds still exist is the entire safety
argument, which is why that floor lives in the program and not in this config. Its corollary: anything
derived from the round log is a *newest-N* statistic and must not be labelled "all time".

`KEEPER_ROUND_RETENTION` can raise the window but **not lower it** — a value below the chain's floor
is refused at boot rather than clamped, because every close inside it would come back `RoundTooRecent`
and a silently-clamped keeper would be running a window its operator did not choose.

**How it drains a backlog.** One round per pass, oldest first, on idle passes only — never during
`Drawing` or `Fight`, because reclaiming rent must not compete with the round somebody is playing.
The cursor starts at round #1 on **every boot**, which is what makes it pick up rounds that were
stranded long before this process started rather than only the ones it opened itself. It only moves
forward, so the scan cannot loop, and the cost is one account read per second no matter how long the
history is. A round it cannot close — wedged in `Drawing`, still delegated, or failing repeatedly —
is logged and stepped past, because one unclosable round must never hold every older round's rent
hostage behind it. An *unswept* round is the one case it fixes instead of skipping: it sweeps, then
closes on a later pass, which also quietly drains the `Treasury.rounds_swept` gap listed under "Known
holes".

**Against a pre-v7 program it does nothing at all**, and says so in the boot banner
(`rent  unavailable — this IDL has no close_round_account`). That veto is `programFeatures.ts`, and it
is the reason a default-on policy is safe: a capability that defaults to on has to be able to prove it
is unavailable.

### The funding floor

The keeper stops **opening** rounds when the payer falls below `KEEPER_MIN_BALANCE_SOL` (default
0.05), and keeps driving whatever round is already in flight all the way to a terminal state.

That asymmetry is the whole design. Running out *between* `delegate_round` and `resolve` is the
expensive failure: the rent is already paid, the round is delegated, and stopping there would strand
that deposit for nothing while leaving a real player's fight unfinished. So the guard refuses to
**start** work it may not be able to finish — the one point where refusing costs nothing — and never
interrupts work already started.

It publishes `keeper.lowBalance` (schema 4), which is a **fourth liveness state**: the keeper is up,
heartbeating, and succeeding on every pass, because refusing to open *is* the correct outcome of a
pass. `isKeeperStale` and `isKeeperStalled` both correctly answer false. Without the field the page
would go on counting down to a next lobby that nothing is going to open — so `keeperCountdown` returns
`none` for the next-lobby case while it is set, and still counts an in-flight lobby down, because that
round genuinely is being finished.

It logs once per stretch rather than per pass, re-reads the balance every 15 seconds while blocked
(one RPC per fifteen passes, not one per pass), and resumes on its own within 15 seconds of a top-up
landing.

## Reading the status file

**One serializer, two channels.** The status leaves this process by two routes and they emit *the same
bytes*, rendered once per publish:

| channel | where | when it is the one that matters |
|---|---|---|
| file | `er-demo/public/keeper-status.json` | local dev — Vite dev, `vite preview` and a production build all serve `public/` verbatim at `/keeper-status.json`, so nothing needs configuring |
| HTTP | `GET /keeper-status.json` on `KEEPER_HTTP_PORT` (default 8080) | **production, always** — the front end is a static build on another host, and a keeper cannot write into a bundle that was finished before it started |

Two serializers over one in-memory object would be the schema drift this whole contract module exists
to prevent, arriving one layer down — and it is the hard kind to see, because both channels keep
working and only *disagree*. `serializeKeeperStatus` is the single place it happens; a test asserts the
HTTP body and the file are byte-identical.

The body a request gets is the last one **published**, not one rendered on demand, and that is
deliberate rather than lazy: rendering reconciles `nextLobbyOpensAt` against the round and advances the
per-round latch that makes that countdown monotonic. If a request rendered its own body, an HTTP `GET`
would mutate keeper state and a page polling twice a second would be participating in the state
machine. It is at most one publish interval old, which is exactly as old as the file, reported by the
same heartbeat.

Both are `Cache-Control: no-store`, and the page asks for it too. A cached liveness report is a lie
about liveness, and reporting liveness is the only reason this thing exists — a 304 or a CDN hit keeps
a dead keeper looking alive for as long as the cache lives. Both ends say it because either end alone
is one misconfiguration away from a stale countdown.

The shape and every rule about it live in `src/v2/data/keeperStatus.ts`, which both this keeper and the
browser import — one module, both ends.

The file is written **atomically** (temp file in the same directory, then `rename`), so a browser
polling it never reads half a document.

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

> **Changed — schema 5 removed the house from this file.** It used to carry a `house` block (all the
> bank's pubkeys plus a paragraph of player-facing prose) and a per-round `houseFighterCount` /
> `realFighterCount` split. All three are gone, and `keeper.lastError.message` went with them — it was
> arbitrary exception text, and a failed house `enter` throws with one of the arena's own wallets
> inside it. What a round still reports is `fighterCount`, `pot`, `phase` and `winner`: every one a
> copy of a public account anybody can read for themselves. `heldOpen` stays, because it exists to
> *stop* a countdown rather than to describe a lineup.
>
> `parseKeeperStatus` **hard-rejects** anything that is not schema 5, which is the point rather than
> housekeeping: a parser that merely ignored the old fields would leave a not-yet-redeployed keeper's
> file carrying every pubkey to every browser exactly as before, with the only difference being that
> nothing displayed it. The cost is one deploy's stretch where the page says "keeper is down".
>
> The old list was a claim made by the same process that runs the bots — believable, not verifiable.
> Registering the house wallets on the Arena account on-chain remains the better design if disclosure
> is ever wanted again; what was removed is the weak version, not the ambition.

The file is gitignored. Its **absence** is meaningful: a 404 is correctly read as "no keeper is
running here" — and so is a connection refused on the HTTP channel. `useKeeperStatus` collapses every
way of failing into the same answer, because showing a countdown for any of them would be inventing
the number.

### The health endpoint

`GET /health` → `200 {"ok":true,"schema":5,"heartbeatAgeSeconds":N}`.

**It makes no chain calls, and that is the whole design.** If it depended on RPC, a devnet blip — a
429, a slow block — would fail the platform's check and get a *perfectly healthy keeper killed
mid-round*, stranding a delegated round whose rent nothing reclaims. The blip is transient; the restart
is not. So it answers from memory only, and it returns 200 for as long as the process is answering:
answering an HTTP request at all already proves the thing a liveness probe is for.

`heartbeatAgeSeconds` is **reported, not enforced**. A stopped heartbeat beside a responsive server
would be a real bug worth seeing — but it is not made a failure, because the condition has never been
observed and the cost of a false positive is a restart landing in the middle of a round. "Is the keeper
*working*" is `keeper.heartbeatAt` and `keeper.stalledSince` in the status, which the front end already
reads.

(`engine/`'s Dockerfile points its check at `/live` and explicitly **not** at `/health`, for the
mirror-image reason: engine's `/health` returns 503 on a solvency freeze, which a restart cannot fix.
Here `/health` is the one that is safe to probe. The divergence is deliberate in both directions.)

### The roster endpoint

`GET /house-wallets.json`, `Authorization: Bearer $KEEPER_HOUSE_TOKEN` → `200 {"wallets":[…]}`.

The one route on this server that is **not** public telemetry. It exists because the identity API
(`er-demo/api/`) has a rule to enforce — a house wallet must never wear a person's X avatar — and it
cannot enforce a rule about wallets it cannot name. It uses the answer **only to withhold**.

**Why a live endpoint rather than a copy of the list.** Two cheaper designs were rejected for the same
reason: a build-time environment variable holding the pubkeys, and a static list committed to the
repo. Both put a *snapshot* of the bank where the API can read it — and the bank **grows**
(`extendHouseBank.ts` exists for that, and production runs 48 wallets against a code default of 10). A
baked-in copy therefore goes stale at exactly the moment a wallet is added, and a house wallet the API
has never heard of is *precisely and only* the case the check exists for. The keeper is the only
process that knows its own bank, so the API asks it. One source of truth, ~one request a minute.

Three properties worth knowing before you touch it:

- **It never sends `Access-Control-Allow-Origin`** — not even to an allowed origin. The CORS allowlist
  decides which *pages* may read public telemetry; the token decides which *services* may read the
  roster, and a browser is never in the second category. If a page ever came to hold the token, the
  missing allow header is the last thing between that and the same-origin policy handing it the bank.
- **No token configured → `404`, not `401`.** A 401 advertises that this keeper holds a roster worth
  protecting. With no token the route genuinely does not exist, so it is indistinguishable from any
  unknown path. For the same reason the 404 body names only `/keeper-status.json` and `/health`, even
  on a keeper that *is* serving the roster.
- **A token shorter than 32 characters is refused and the route stays off**, with a warning naming the
  actual length. The route is public on a public hostname; the token's entropy is all of its security,
  and a short one accepted "for now" is one nothing will ever remind anybody about.

```sh
# generate once, then set the SAME value on both ends
openssl rand -base64 24
fly secrets set KEEPER_HOUSE_TOKEN='…' -a bulls-arena-keeper-devnet   # the keeper
# …and KEEPER_HOUSE_TOKEN in the Vercel project                        # the identity API
```

**If you do not set it**, on either end: the keeper logs a loud warning and serves no roster, and the
API — which fails **closed** by design — serves **no avatars at all, for everybody**, not just for
house wallets. Nothing on either side renders an error a person would notice, which is why both ends
say so at boot. The Vercel half goes further and refuses to cold-start without it, so the first request
after a deploy is a 500 at the origin rather than a site that quietly looks like nobody has ever linked
an account.

## Deploying it

`Dockerfile`, `.dockerignore` and `fly.toml` live in `er-demo/`, which is also the build context —
unlike `engine/`, which builds from the repo root because it also ships `web/`. The keeper imports
nothing outside `er-demo/`.

### The whole path

```sh
cd er-demo

# 1. create the app (no volume — see fly.toml rule 2; there is nothing to persist)
#    --ha=false is NOT optional. See "One instance" below: without it Fly starts TWO machines.
fly launch --no-deploy --copy-config --ha=false --name bulls-arena-keeper-devnet

# 2. the two secrets. NEVER in the image, never in fly.toml, never in git.
fly secrets set KEEPER_OPERATOR_KEY="$(cat ../.devnet/fork-payer.json)"
fly secrets set KEEPER_HOUSE_WALLETS="$(cat ../.devnet/keeper-house-wallets.json)"

# 3. who may read the status from a browser. NOT optional — without it a deployed page is
#    blocked by CORS and reports the keeper as down. Never "*".
fly secrets set KEEPER_CORS_ORIGIN="https://bulls-vs-unicorns.vercel.app"

# 4. deploy — --ha=false EVERY time, not just the first
fly deploy --ha=false

# 5. prove it is alive, and prove there is exactly ONE machine
fly status                      # expect a single machine, started
fly machine list                # if there are two, `fly machine destroy <id>` the extra NOW
fly logs
curl -s https://bulls-arena-keeper-devnet.fly.dev/health
curl -s https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json | jq .

# 6. point the front end at it — in the VERCEL project, then redeploy the front end
#    VITE_KEEPER_STATUS_URL=https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json
```

Step 6 is a **build-time** value: Vite inlines it into the bundle, so it must be set in Vercel's
environment *before* the build, and changing it needs a front-end redeploy. That is the correct shape
for a value that is part of the artifact. `KEEPER_STATUS_URL` in `src/v2/data/keeperStatus.ts` reads it
and falls back to the relative `/keeper-status.json`, so **local development is unaffected and no UI
file changes**.

### Preview deployments, and the wildcard that would "fix" them

Vercel gives every preview deployment its own hostname —
`https://bulls-vs-unicorns-6t45yhqn7-davincibles-projects.vercel.app` — so the one exact origin above
covers production and nothing else.

**Do not reach for `*`.** `KEEPER_CORS_ORIGIN` refuses a value containing one outright, discards the
whole value with it and falls back to local-dev origins, and that refusal is deliberate: an origin
allowlist that quietly matches everything is precisely the thing the list exists to avoid. The two
honest options are (a) add the specific preview origin to the comma-separated list for as long as you
need that preview to read live keeper status, or (b) accept that previews read nothing and render
"keeper is down", which is the safe failure. A preview that cannot read the status is a cosmetic gap
that dies with the preview; a wildcard is a permanent one.

The practical consequence, so nobody debugs it twice: **a preview build looks like a dead arena while
the keeper is perfectly fine.** Judge keeper liveness from production or from `curl`, never from a
preview URL.

### Rehearsing the image without Docker

Worth knowing, because it caught a boot failure that no test and no type-check could: copy out
*exactly* what the `Dockerfile` copies, and run the keeper from there with the secrets in the
environment. It costs nothing and it is the only check that exercises the deployed file tree.

```sh
SIM=/tmp/keeper-image-sim && rm -rf "$SIM" && mkdir -p "$SIM/public"
cp package.json bun.lock "$SIM/"; cp -R src scripts "$SIM/"; cp -R public/idl "$SIM/public/idl"
ln -s "$PWD/node_modules" "$SIM/node_modules"          # the image reinstalls these; a symlink is fine here
cd "$SIM" && \
  KEEPER_OPERATOR_KEY="$(cat ../../.devnet/fork-payer.json)" \
  KEEPER_HOUSE_WALLETS="$(cat ../../.devnet/keeper-house-wallets.json)" \
  KEEPER_HTTP_PORT=18084 bun run scripts/keeper/keeper.ts --dry-run
```

`.devnet/` is unreachable from that tree, so the run proves the **env-only secret path** as well as
the file list. What it found the first time: the ER-validator preflight read
`target/deploy/bulls_arena.so`, a gitignored Rust artifact at the repo root that cannot exist in the
image — the keeper died at boot with `ENOENT` before opening a round. `referenceBytecode` in
`scripts/erValidator.ts` now falls back to reading the deployed bytecode from the base layer, which is
the more authoritative reference anyway and is available everywhere.

### Every environment variable

Secrets — `fly secrets`, read at boot, **never** baked into the image. Env beats file; which source
won is logged at boot, the key material never is.

| variable | fallback | what it is |
|---|---|---|
| `KEEPER_OPERATOR_KEY` | `.devnet/fork-payer.json` | the **arena authority** secret key, a JSON array of 64 numbers. `open_round` and `delegate_round` are both `has_one = authority`; the keeper refuses to start if this key is not the arena's authority |
| `KEEPER_HOUSE_WALLETS` | `.devnet/keeper-house-wallets.json` | the house-fighter keys, the **verbatim contents** of that file (`{"note": …, "secretKeys": [[…]]}`). Keys that arrive this way are never written back to disk |
| `KEEPER_HOUSE_TOKEN` | *none — the route is not served* | bearer token for `GET /house-wallets.json`, minimum **32 characters**. Must match `KEEPER_HOUSE_TOKEN` in the Vercel project. Unset on either end means the identity API serves **no avatars at all** — see "The roster endpoint" |

Configuration — safe in `fly.toml`'s `[env]`, except where noted.

| variable | default | what it is |
|---|---|---|
| `KEEPER_HTTP_PORT` | `8080` | port for `/keeper-status.json` and `/health`, bound `0.0.0.0`. Must match `internal_port` in `fly.toml` |
| `KEEPER_CORS_ORIGIN` | *(unset → local dev origins only)* | comma-separated **exact** browser origins. `*` is refused outright and the whole value with it. Unset logs a loud warning and blocks any deployed page |
| `KEEPER_BASE_RPC` | `https://api.devnet.solana.com` | base-layer Solana RPC. A paid endpoint carrying an API key is a **secret**, not an `[env]` line |
| `KEEPER_ROUTER_URL` | `https://devnet-router.magicblock.app` | the MagicBlock Magic Router |
| `KEEPER_HOLD_OPEN` | `0` (`1` in `fly.toml`) | the hold-open lobby policy — see "Two lobby policies" and the arithmetic below |
| `KEEPER_REAL_PLAYER_GRACE_SECONDS` | `45` | how long entries stay open after the first real player arrives, and therefore the whole window the house arrives across — see "When they arrive". Refused below the chain's `MIN_LOBBY_SECONDS` (20) or above `MAX_LOBBY_SECONDS` |
| `KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS` | `5` | the quiet between the last scheduled house arrival and the draw: time for the final entries to confirm, and a beat of stillness before the bell. Must be shorter than the grace and longer than the clock-skew margin |
| `KEEPER_HOUSE_WALLET_COUNT` | `10` | how many wallets the bank holds, and the ceiling on the roster. Raising it is a **two-step** — see "Raising the wallet count". Costs 0.01 SOL parked per wallet |
| `KEEPER_HOUSE_BOARD_TARGET` | `10` | total fighters the house holds the board at, counting real players. Must not exceed the wallet count; refused at boot if it does |
| `KEEPER_HOUSE_DISPLACEMENT` | `1` | house seats given up per real entrant. `0` means the house never withdraws; `2` restores the old "leaves at two real players" policy |
| `KEEPER_HOUSE_STAKE_MIN_USD` | `5` | floor of the band house stakes are drawn from. The smallest preset a real player is offered |
| `KEEPER_HOUSE_STAKE_MAX_USD` | `20` | ceiling of that band, and **the single number that decides house exposure per round** — see "What it puts at risk". `50` restores the old band and roughly doubles it |
| `KEEPER_CLOSE_ROUNDS` | `1` (**on**) | reclaim finished rounds' rent (~0.0086 SOL each, 95% of a round's cost). `0` or `--no-close-rounds` disables it — see "Reclaiming the rent" |
| `KEEPER_ROUND_RETENTION` | `20` (the chain's `MIN_RETAINED_ROUNDS`) | how many newest rounds are never closed. Can be **raised**, never lowered — a lower value is refused at boot |
| `KEEPER_MIN_BALANCE_SOL` | `0.05` | below this the keeper opens no new rounds, while finishing any round in flight — see "The funding floor" |
| `VITE_KEEPER_STATUS_URL` | `/keeper-status.json` | **front end only**, set in Vercel, not here. The full absolute URL of the endpoint above |
| `VITE_BASE_RPC` | `https://api.devnet.solana.com` | **front end only**, set in Vercel, not here. The browser's base-layer RPC — deliberately a *different* key from `KEEPER_BASE_RPC`, see below |

Both *keeper* URL variables run through `assertDevnetUrl` at boot, before any connection is
constructed (`VITE_BASE_RPC` gets the same guard on the browser side, in `src/chain/constants.ts`). **A
mainnet URL in a Fly secret kills the process loudly rather than connecting** — env indirection is not
allowed to become the hole in the mainnet guard. The guard fails *closed*, so a bare API-key URL with
no cluster in the hostname is refused too: use the provider's devnet hostname
(`devnet.helius-rpc.com`), so the URL states its own cluster.

Every knob in `config.ts` is still available (`KEEPER_RESULT_HOLD_SECONDS`, `KEEPER_DRAW_TIMEOUT_SECONDS`,
`KEEPER_CLOSE_RETRY_SECONDS`, …), each with the argument for its value beside it.

`KEEPER_HOUSE_FILL_LEAD_SECONDS` is **gone**, and a keeper that is still being given it **refuses to
boot** rather than ignoring it. It named the instant the house stepped up to its full board; that job
now belongs to `KEEPER_REAL_PLAYER_GRACE_SECONDS` and `KEEPER_HOUSE_ARRIVAL_TAIL_SECONDS`, which
between them define the window the house arrives across. A silently-ignored knob on a live keeper is a
deployment behaving differently from the one its operator believes they configured.

### `VITE_BASE_RPC` and `KEEPER_BASE_RPC` hold different keys, on purpose

Two variables for the same endpoint looks like duplication that wants tidying up. It is not:
**the browser's key is public and the keeper's is not.** Vite inlines every `import.meta.env.VITE_*`
reference into the JavaScript bundle at build time, so whatever sits in `VITE_BASE_RPC` ships to
every visitor and is trivially readable — confirmed by grepping the built `dist/`, not assumed. That
is not a leak to be fixed; it is what a static front end *means*, and any RPC key a browser uses is
public by construction. `KEEPER_BASE_RPC` never takes that path: it arrives from `fly secrets` at
runtime and is in neither the image nor the repo.

So give them **different keys**. The browser gets one you are willing to have scraped —
rate-limited, restricted by domain or referrer if the provider supports it, and cheap to rotate. The
keeper keeps a private one. Share a single key between them and the copy sitting in the bundle *is*
the key the keeper depends on: the day it gets abused and you rotate it, you take the arena down
with it.

The `VITE_` prefix is the entire mechanism. A variable **without** it is never inlined, which is what
keeps `KEEPER_*` names out of the browser even while both sets live in the same `.env` file during
local development.

Where they are set today: `VITE_BASE_RPC` is a Helius **devnet** endpoint on all three Vercel
environments; `KEEPER_BASE_RPC` is a line in a gitignored local `.env`, and becomes a `fly secret`
in production — which is the same rule the secrets table above states, arrived at from the other
direction.

### A healthy deployment, in one look

```
$ curl -s https://bulls-arena-keeper-devnet.fly.dev/health
{"ok":true,"schema":5,"heartbeatAgeSeconds":1}
```

`heartbeatAgeSeconds` under `staleAfterSeconds` (15) is what **you** read; the platform's check
deliberately ignores it and passes on the 200 alone (see the health endpoint above — a check that
could fail on a devnet blip would restart a healthy keeper mid-round). A number climbing past 15 while
the endpoint still answers means the loop's timer has stopped: the process is up and not keeping time.
That is the one condition here a restart genuinely fixes, and it is the one you have to act on
yourself, because nothing else will.

```
$ curl -s https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json | jq '{schema, cluster: .chain.cluster, age: (now - .keeper.heartbeatAt | floor), stalled: .keeper.stalledSince, round: .round.no, phase: .round.phase, fighters: .round.fighterCount, held: .round.heldOpen}'
{ "schema": 5, "cluster": "devnet", "age": 1, "stalled": null, "round": 5, "phase": "Lobby", "fighters": 1, "held": true }
```

That is a healthy idle keeper under `--hold-open`: one lobby, held, waiting for a person. The four
things to read, in order — everything else is detail:

1. `age` (`now - keeper.heartbeatAt`) **under 15**. Over it, the keeper is down and nothing else in the
   file means anything.
2. `keeper.stalledSince` is `null`. Non-null is the third state: alive, heartbeating, and its loop
   failing every pass. A restart will not help — `keeper.lastError.context` says which PART is failing
   (`main-loop`, `entry-fill`, `take-sweep`, …); the *reason* is in the Fly logs, deliberately, because
   exception text names accounts and this file is public.
3. `chain.cluster` is `"devnet"`. It is written unconditionally and asserted by the parser; if it were
   ever anything else, something is very wrong upstream.
4. `round` is non-null and its `phase` moves. `roundsCompleted` rising is the "it is actually doing the
   job" signal; under `--hold-open` it can legitimately sit still for an hour, which is the point.

If the browser says "keeper is down" while `/health` answers, it is almost always one of two things,
and they are distinguishable in one command:

```sh
# CORS — the page's origin is not on the list. Look for the allow header.
curl -sD - -o /dev/null -H "Origin: https://bulls-vs-unicorns.vercel.app" \
  https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json | grep -i access-control
```

No `Access-Control-Allow-Origin` in that output → fix `KEEPER_CORS_ORIGIN` (exact origin, no trailing
slash, no path). Header present → the front end was built without `VITE_KEEPER_STATUS_URL`; it is
polling its own origin and getting Vercel's 404. Set it in Vercel and rebuild.

### One instance, and what a restart does

**`fly deploy --ha=false`, every time.** This is the one that will actually bite: Fly Launch creates
and starts **two** machines by default for a process group with services, and does it again on any
deploy that follows a scale-to-zero. Nothing in `fly.toml` can prevent it — `min_machines_running` is
a floor, not a ceiling, and Fly has no maximum-machine-count setting. `fly status` after every deploy
is the check; two machines is two keepers, and the paragraph below is what that costs.

`fly.toml` does what it can: `auto_stop_machines = "off"`, `auto_start_machines = false`, and
`strategy = "rolling"` — which on a single-machine app updates that machine *in place*, so a deploy
has a window with zero keepers and never one with two. **Never `fly scale count 2`**, and never
`canary` or `bluegreen`, both of which boot a second machine alongside the running one on purpose.
(`min_machines_running = 1` is in the file and is **inert** under `auto_stop_machines = "off"`; it is
kept as a statement of intent and labelled as inert, not as a mechanism.)

Two keepers both read `arena.round_counter` and both reach for `counter + 1`. The loser gets
`RoundOutOfOrder` and backs off, which is loud and survivable on its own. What is not survivable is
what it leaves: the round it was driving is now *behind* the counter, unreachable by a phase machine
that correctly follows the chain rather than its own memory, sitting delegated past its deadline
holding ~0.0085 SOL of rent that no instruction reclaims. This is written up under "Known holes" below
because it has already happened.

**Brief overlap during a restart is mostly benign, and it is worth being precise about the "mostly".**
Nothing here acts from memory: every pass re-derives from the chain, so a duplicate `close_round`,
`resolve`, `tick` or `sweep_house_take` costs a signature and the program refuses the second — the same
property that makes a crash mid-fight indistinguishable from a fresh boot. Two operations are not
covered by that argument:

- **`open_round`** is a genuine race, and it is the expensive one. Both processes can pay for a round
  PDA in a racing sequence and only one round survives the counter; that rent is not recoverable.
- **`enter` for a house fighter** is not idempotent either — a duplicate *tops up* an existing fighter's
  stake rather than failing. It costs a signature and distorts one round's house stake; it does not
  strand anything.

So `strategy = "rolling"` plus `kill_timeout = 20` keep a *deploy* from ever producing overlap at all,
and bound the shutdown to about a second in practice (the keeper answers SIGTERM by finishing the
current step, and every wait inside a step is interruptible). What they do not do is protect against a
second machine arriving by another route — `--ha=false` omitted, a manual `fly machine clone`, someone
running the keeper locally against the same arena. Nothing structural closes that; one machine does,
and `fly status` is how you know you still have one.

**No volume**, and nobody should add one: the loop re-derives everything from the chain, which is
exactly why restart works and why there is no reconciliation routine in this codebase to rot. The one
piece of persisted local state was the house-wallet key file, and in production that arrives as a
secret. There is genuinely nothing to keep.

### The money, before you need it

**How long until it dies.** The payer pays for everything; the house wallets only pay their own
signatures. Measured, reconciled across 28 real rounds:

```
per round, all-in                  0.00981 SOL
  of which permanently locked      0.00850 SOL   round-PDA rent — no instruction reclaims it
```

The cadence decides everything else:

| policy | rounds/hour idle | SOL/hour idle | 6.64 SOL lasts | 1.93 SOL lasts |
|---|---|---|---|---|
| fixed cadence (`KEEPER_HOLD_OPEN=0`) | ~33 (one per ~110s) | **~0.32** | ~21 hours | ~6 hours |
| hold open (`KEEPER_HOLD_OPEN=1`) | 1 (one per backstop) | **~0.0098** | ~28 days | ~8 days |

The arithmetic is one division — `hours = balance ÷ SOL-per-hour` — and the table is there so nobody
has to be told which number to divide by. Hold-open's figure is a **floor**: every round a real player
actually causes costs the same 0.00981, so a busy arena burns closer to the fixed-cadence rate. That is
the correct way round — paying rent for rounds people played is the product working.

**Check the balance** without a CLI, from anywhere:

```sh
curl -s https://api.devnet.solana.com -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj"]}'
# {"result":{"value":6639802640}}  ->  6.6398 SOL   (lamports ÷ 1e9)
```

The keeper prints it too, in the boot banner and in each round summary as a measured balance delta
rather than an estimate — but the boot banner is only true at boot, and this is the question you ask at
3am.

**Fund it** from the public devnet faucet at <https://faucet.solana.com> (paste the address above), or
`solana airdrop 2 9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj --url devnet` if you have the CLI. The
faucet is rate-limited and regularly dry; give yourself days of runway rather than hours, which the
hold-open row above makes cheap. (`scripts/fund-wallet.mjs` sends *from* this payer to a burner — it is
not a way to top the payer up.)

**What running out looks like, so it is recognised rather than debugged.** The keeper announces it,
which it did not used to — see "The funding floor" above. Expect:

- one loud block of `OUT OF FUNDS` in the log naming the balance, the floor, the round it declined to
  open and the address to send SOL to. **Once per stretch, not once per pass**, so it does not bury
  itself;
- `roundsCompleted` stops rising, and `keeper.lowBalance` in the status carries the balance and the
  floor as lamport strings. The page stops promising a next lobby and says the arena is out of funds
  — a different sentence from "keeper is down", because the keeper is not down;
- the round already in flight **finishes normally**. Its countdown keeps running, the fight resolves,
  the round settles and undelegates. Only the *next* one never opens;
- `keeper.stalledSince` stays **null**, and this is the part worth internalising: refusing to open is
  the correct outcome of a pass, not a failure, so nothing increments a failure count. A keeper out of
  money is not a stalled keeper, and looking for `stalledSince` will mislead you;
- `/health` keeps returning **200** throughout, and Fly does not restart anything. That is correct: the
  process is fine, it is out of money, and restarting it would not add any.

So the signature is **`lowBalance` non-null + `stalledSince` null + `/health` fine**. It resumes on its
own within 15 seconds of a top-up landing — no restart, no deploy.

If a keeper looks wedged in some *other* way, check the balance before anything else anyway; it is one
`curl` and it remains the most common cause of an arena that has stopped doing anything.

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
