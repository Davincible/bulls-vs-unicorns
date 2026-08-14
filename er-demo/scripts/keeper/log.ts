// THE KEEPER'S LOG — an unattended process's only evidence of what it did.
//
// Every line carries a full ISO timestamp and the round number it happened under. Both are there for
// the same reason: this process is meant to run for hours with nobody watching, and the question
// asked of its output afterwards is always "what was it doing at 20:41, and to which round?". A
// timestamp of `20:41:03` with no date is unreadable across a run that spans midnight; a line that
// says "enter failed" with no round number cannot be matched against the chain.
//
// The round tag is module state, set once per pass of the main loop. That is the one piece of mutable
// module-level state in scripts/keeper/, and it is deliberate: it is COSMETIC — nothing reads it back
// to decide anything — and threading a logger object through every function in the phase machine to
// carry a number that is the same for the whole pass would be ceremony that obscures the machine
// itself. It is re-derived from the chain on every pass like everything else, so it cannot go stale.

import { LAMPORTS_PER_SOL } from "@solana/web3.js";

// The one shared classifier, aliased because this module re-exports the same NAME at a different
// arity — `failedWith(e, name, code)` here takes the thrown value, `failedWithText(text, name, code)`
// takes text that something has already flattened. See `failedWith` below for why this directory
// reaches into `src/v2/data/` for it instead of keeping a local copy.
import { errorText, failedWith as failedWithText } from "../../src/v2/data/programError.ts";

export const c = {
  r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m",
  d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m",
} as const;

let currentRound: bigint | null = null;

/** Set (or clear) the round number every subsequent line is tagged with. Called once per pass of the
 *  main loop, from the round number the chain just reported. */
export function setLogRound(roundNo: bigint | null): void {
  currentRound = roundNo;
}

function line(level: string, message: string): string {
  const tag = currentRound === null ? "     " : `#${currentRound}`.padEnd(5);
  return `${c.d}${new Date().toISOString()}${c.x} ${c.c}${tag}${c.x} ${level} ${message}`;
}

export function info(message: string): void { console.log(line(`${c.d}··${c.x}`, message)); }
export function ok(message: string): void { console.log(line(`${c.g}✓${c.x} `, message)); }
export function warn(message: string): void { console.log(line(`${c.y}!${c.x} `, `${c.y}${message}${c.x}`)); }
export function error(message: string): void { console.error(line(`${c.r}✗${c.x} `, `${c.r}${message}${c.x}`)); }

/** A section header — used for the startup banner and the per-round summary, the two places where a
 *  block of related lines is easier to read than a stream of tagged ones. */
export function heading(message: string): void { console.log(`\n${c.b}${message}${c.x}`); }

/** Plain, untagged output. For the banner and the per-round summary block, where a timestamp on every
 *  line would be noise — the block's own header already carries one. */
export function plain(message: string): void { console.log(message); }

/** Sleep, INTERRUPTIBLY.
 *
 *  Every wait in this keeper goes through here and takes the shutdown signal, because the alternative
 *  is a process that ignores SIGTERM for the better part of a minute. The uninterruptible waits added
 *  up: up to 30s watching for an undelegate commit, 10s for a delegation hand-off, ~6s of resolve
 *  retries, up to 30s of error backoff. A `docker stop` (10s grace) or a Kubernetes
 *  `terminationGracePeriodSeconds: 30` would SIGKILL through all of that — which would skip the
 *  deliberate exit path that stops the heartbeat and lets the status file go honestly stale, the one
 *  piece of shutdown behaviour this design actually cares about.
 *
 *  It RESOLVES on abort rather than rejecting. A caller that was waiting for something is not in an
 *  error state because it was asked to stop; it should fall out of its loop and re-check its own
 *  condition, which is what every call site here does. Rejecting would turn a clean shutdown into a
 *  `lastError` in the status file. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** THIS MACHINE'S clock, in unix seconds. Log timestamps only.
 *
 *  NOT for anything the phase machine compares against a chain-stamped field — use `client.nowSec()`,
 *  which corrects for the measured offset between this host and the chain. See
 *  `CLOCK_RESYNC_SECONDS` in config.ts for what an uncorrected host clock does to this state machine. */
export const hostNowSeconds = () => Math.floor(Date.now() / 1000);

export function fmtSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

/** A duration in seconds, rendered for a human. `null` prints as "unknown" rather than as 0 — a
 *  duration this process did not observe (because it booted into the middle of a round) is genuinely
 *  not known, and printing 0.0s for it would be inventing a measurement. */
export function fmtDuration(seconds: number | null): string {
  return seconds === null ? "unknown" : `${seconds.toFixed(1)}s`;
}

/** True when a failed transaction was rejected by a SPECIFIC Anchor error — on EITHER layer.
 *
 *  TWO OUTAGES ARE WRITTEN INTO THIS ONE FUNCTION. Both stranded a delegated round in `Fight`, both
 *  did it by silently reducing the same three-attempt `resolve` retry to a single attempt, and the
 *  second was introduced BY THE FIX FOR THE FIRST. That is why the argument below is this long: the
 *  log-only form was a live production defect, not a stylistic preference, and the shape of the
 *  mistake — "classify the failure by something only one of the two layers actually sends" — is one
 *  this repo has now made twice.
 *
 *  THE FIRST WAS `e instanceof anchor.AnchorError`. `sendTx` sends through
 *  `Connection.sendRawTransaction`, so Anchor's `translateError` — which runs only inside
 *  `AnchorProvider`'s own send/simulate path — never sees the failure, and the throw is ALWAYS a
 *  `SendTransactionError`. The `instanceof` was therefore always false. See `verify-session-real.mjs`
 *  step 12, where exactly that stranded a round.
 *
 *  THE SECOND WAS ITS REPLACEMENT: `new RegExp("Error Code: " + name).test(logsOf(e))`, matching the
 *  `Error Code: <name>.` line Anchor writes at the point of failure. That line lives in PROGRAM LOGS,
 *  and program logs exist only on the base layer. `resolveRound` — this predicate's one and only call
 *  site — sends through the Magic Router against a round that is delegated by construction, i.e. into
 *  the Ephemeral Rollup, and THE ROLLUP RETURNS NO LOGS. Captured verbatim on devnet (commit bb3ef3c;
 *  the fixture is `routerError` in `src/v2/data/chainErrorShapes.ts`):
 *
 *      transactionMessage: "solana rpc request error: RPC response error -32003: transaction
 *                           verification error: Error processing Instruction 0:
 *                           custom program error: 0x1775; "
 *      transactionLogs:    undefined
 *
 *  THE `0x1775` THERE IS NOT THIS ERROR — it is 6005, `BadSide`, from the doomed `enter` that produced
 *  the capture; `FightNotOverYet` is 6013 and would arrive as `0x177d`. The capture is quoted for its
 *  SHAPE, not its number, and is left exactly as it was found rather than edited to suit the paragraph
 *  it illustrates — `chainErrorShapes.ts` takes the same position and `programError.ts`'s header
 *  records the same loose end. What is reused is the wrapper text, the absent logs, and the
 *  `custom program error: 0x…` form; every caller supplies its own number.
 *
 *  `undefined` and not `[]`, which is not pedantry: the router's JSON-RPC error carries no
 *  `data.logs` at all, so web3.js's `SendTransactionError` constructor never receives an array to
 *  hold. A matcher keyed on logs has nothing to read. So on the only path a live round takes, this
 *  answered `false` for every genuine `FightNotOverYet`, `resolveRound`'s `throw e` fired on attempt
 *  one, and `RESOLVE_RETRY_ATTEMPTS` was decorative. The cost is not abstract: a round that misses its
 *  resolve window stays in `Fight`, and `close_round_account` can only reclaim a round's ~0.0235 SOL
 *  of rent from a TERMINAL phase, so the rent is stranded with it.
 *
 *  HENCE THE THIRD PARAMETER, AND HENCE IT IS REQUIRED RATHER THAN OPTIONAL. On the rollup the hex
 *  code is the only signal in the error, so a name-keyed predicate cannot work there and no amount of
 *  regex care will change that. Making `code` optional would let some future call site omit it and
 *  quietly inherit exactly the base-layer-only behaviour described above — for the third time. A
 *  required parameter makes the question "what is this error's number on the deployed program?"
 *  unavoidable at every call site.
 *
 *  THE NUMBER IS NOT WRITTEN DOWN, HERE OR ANYWHERE. `#[error_code]` numbers start at 6000 and shift
 *  whenever a variant is inserted above, so a literal `6013` starts meaning a different error the next
 *  time the Rust enum grows one — and it would do so silently, because the wrong number still matches
 *  something. Callers resolve it with `errorCodeOf` against the IDL LOADED AT RUNTIME; see
 *  `fightNotOverYetCode` in keeper.ts.
 *
 *  IT DELEGATES TO `src/v2/data/programError.ts` RATHER THAN REIMPLEMENTING THE RULES, and that is a
 *  deliberate exception to this directory's habit of not reaching into `src/`. The usual objection —
 *  the keeper must not acquire browser dependencies — does not apply: `programError.ts` imports
 *  NOTHING, has no React in it and is pure by explicit design, for the same reason this keeper's
 *  modules are (a decision that matters must be callable from a plain Node test). `statusFile.ts` and
 *  `statusServer.ts` already share `src/v2/data/keeperStatus.ts` on exactly this basis. The
 *  alternative — a keeper-local copy — would make this the THIRD transcription of the name-wins rule
 *  and the fourth of the captured wire shapes, which is the drift `chainErrorShapes.ts`'s own header
 *  argues against at length, and it would have to be re-fixed by hand every time the browser side
 *  learns something new about how a layer words a refusal.
 *
 *  A NAME THAT IS PRESENT DECIDES — enforced inside `programError.ts`'s `failedWith`, and worth
 *  knowing about from here because it is what keeps the number from doing harm. On the base layer the
 *  name, the number and the hex all arrive in ONE text, so an unconditional "name OR number OR hex"
 *  would let a colliding NUMBER speak for an error the NAME has already identified as something else.
 *  If the text names an error at all, the answer is whether it names THIS one; the number is consulted
 *  only where there is no name, which is the rollup.
 *
 *  THE 6001 COLLISION IS STILL REAL, AND THIS FUNCTION DOES NOT SOLVE IT. Error numbers are assigned
 *  per-crate with no coordination, so session-keys' `SessionError::InvalidToken` and bulls-arena's
 *  `ArenaError::RoundOutOfOrder` are both 6001 and both arrive as `0x1771`. On the base layer the
 *  name-wins rule separates them. ON THE ROLLUP NOTHING CAN: the wire carries one hex code and no
 *  other information, so `failedWith(e, "RoundOutOfOrder", 6001)` would match a `SessionError` there
 *  and no implementation reading that error can do better.
 *
 *  WHAT STOPS THAT BEING A PROBLEM IN THIS PROCESS IS STRUCTURAL, NOT TEXTUAL, and it is checkable
 *  rather than hoped for. Every transaction the keeper sends is signed by a RAW `Keypair` and never by
 *  a session wallet — `ctx.operator` for the arena and round instructions, and a house wallet's own
 *  keypair for the house entries (`houseBank.ts`, `client.send(builder, entry.wallet.keypair, …)`).
 *  `enter` is the only instruction that accepts a session token at all, and `houseBank.ts` passes it
 *  `sessionToken: null` explicitly, calling a session key there "pure ceremony". A `SessionError`
 *  cannot be raised by a transaction that carries no session token, so 6001 is unambiguous HERE even
 *  on the rollup.
 *
 *  THAT ARGUMENT IS ABOUT THE KEEPER'S TRANSACTIONS, NOT ABOUT THIS FUNCTION, which is why it is
 *  written here rather than enforced in code — nothing in a text matcher can check who signed. So
 *  anyone adding a call site for a colliding code must re-establish it rather than inherit it, and
 *  anyone handing the keeper a session wallet invalidates it outright. `FightNotOverYet` (6013) is
 *  unique across both crates and depends on none of this. */
export function failedWith(e: unknown, errorCodeName: string, code: number | undefined): boolean {
  return failedWithText(errorText(e), errorCodeName, code);
}

/** One line describing a failure, with the tail of the program logs when there are any. The logs are
 *  where the Anchor error name lives, so truncating them away is throwing out the diagnosis. */
export function describeError(e: unknown): string {
  const err = e as { logs?: string[]; message?: string };
  if (Array.isArray(err?.logs) && err.logs.length > 0) {
    return `${err.message ?? String(e)}\n${err.logs.slice(-12).map((l) => "        " + l).join("\n")}`;
  }
  return e instanceof Error ? e.message : String(e);
}
