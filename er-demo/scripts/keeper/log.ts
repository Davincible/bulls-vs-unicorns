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

/** The program's own log lines from a failed transaction, as one string.
 *
 *  EVERY error-identity check in this keeper goes through here rather than through
 *  `instanceof anchor.AnchorError`, and that is a correction that has already cost this repo a
 *  stranded round. `sendTx` sends via `Connection.sendRawTransaction`, so Anchor's `translateError` —
 *  which only runs inside `AnchorProvider`'s own send/simulate path — never sees the failure. The
 *  error is ALWAYS a `SendTransactionError`, so `e instanceof AnchorError` is always false, and a
 *  retry guarded by it silently becomes a single attempt. See `verify-session-real.mjs` step 12,
 *  where exactly that reduced a three-attempt `resolve` retry to one and stranded a delegated round
 *  in Fight phase. The `Error Code: <name>` line Anchor logs at the point of failure is the only
 *  place the error's NAME survives. */
export function logsOf(e: unknown): string {
  const withLogs = e as { logs?: unknown; transactionLogs?: unknown };
  const logs = withLogs?.logs ?? withLogs?.transactionLogs ?? [];
  return Array.isArray(logs) ? logs.join("\n") : String(logs);
}

/** True when a failed transaction was rejected by a SPECIFIC Anchor error, proven from the logs.
 *
 *  Matched by NAME, never by number: `#[error_code]` numbers from 6000 with no cross-crate
 *  coordination, so session-keys' `SessionError::InvalidToken` and bulls-arena's own
 *  `ArenaError::RoundOutOfOrder` are both 6001 and both arrive on the wire as `0x1771`. */
export function failedWith(e: unknown, errorCodeName: string): boolean {
  return new RegExp(`Error Code: ${errorCodeName}\\b`).test(logsOf(e));
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
