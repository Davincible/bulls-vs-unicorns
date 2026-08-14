// THE TWO SHAPES THE TWO LAYERS ACTUALLY THROW, CAPTURED ONCE — test support, imported only by
// `*.test.ts`. Nothing in the app imports this module and nothing should.
//
// WHY THIS BREAKS THIS REPO'S SELF-CONTAINED-TEST CONVENTION, DELIBERATELY. Every other test file
// here builds its own fixtures inline, and that is usually right: a test that shares a helper with
// the code it tests proves only that one thing equals itself. These two are different in kind. They
// are not fixtures somebody designed — they are EVIDENCE, transcribed from a real devnet run, and
// three separate classifiers (`entryWindow.ts`'s `refusalFromProgramError`, `useActions.ts`'s
// `isFightBehind`, `walletFault.ts`'s session check) now depend on being right about them.
//
// Copied into three files, they would drift, and drift here has a specific and already-paid cost:
// `isFightBehind` and `SESSION_GONE` were both written against BASE-LAYER strings, both fully
// tested, and both unreachable on the rollup — which is where every real fight runs. A test suite
// built out of imagined wording is precisely the defect; three independent transcriptions of the
// real wording is the same defect with more places to make it. One transcription, three consumers,
// and a correction to the capture lands on all three at once.
//
// PROVENANCE — `src/v2/data/programError.ts`'s header records the run these came off: doomed
// `enter`s at the deployed program on devnet (v8, ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe),
// through `ConnectionMagicRouter` for the rollup shape and through the base RPC for the other. Both
// are transcriptions of a thrown object that was printed, not reconstructions of one that was
// described.

/**
 * WHAT THE MAGIC ROUTER ACTUALLY THROWS — no logs, no name, one hex code, captured verbatim.
 *
 * `transactionLogs` is `undefined` and not `[]`: the router's JSON-RPC error carries no `data.logs`
 * at all, so web3.js's `SendTransactionError` constructor never gets an array to hold. That is the
 * single most load-bearing fact in `programError.ts`, and the reason a matcher reading `e.logs`
 * finds nothing on the only path players use.
 *
 * `name` and `signature` are set because the real object carries them and classifiers read `name`:
 * `walletFault.ts`'s `readThrown` puts it into the matched text, and an empty `signature` is what
 * tells `entryWindow.ts` the transaction never reached the cluster.
 */
export function routerError(hex: string): Error & {
  transactionMessage?: string;
  transactionLogs?: string[];
  signature?: string;
} {
  const e = new Error(
    "Simulation failed. \nMessage: solana rpc request error: RPC response error -32003: " +
      `transaction verification error: Error processing Instruction 0: custom program error: ${hex}; . ` +
      "\n\nCatch the `SendTransactionError` and call `getLogs()` on it for full details.",
  ) as Error & { transactionMessage?: string; transactionLogs?: string[]; signature?: string };
  e.name = "SendTransactionError";
  e.signature = "";
  e.transactionMessage =
    "solana rpc request error: RPC response error -32003: transaction verification error: " +
    `Error processing Instruction 0: custom program error: ${hex}; `;
  e.transactionLogs = undefined;
  return e;
}

/**
 * What the BASE layer throws for the same refusal: the same wrapper, with Anchor's logs intact.
 *
 * KEPT, AND NOT REPLACED BY THE ROLLUP SHAPE. Nothing a player does lands here any more — a live
 * round is delegated — but three things still read this shape and would regress silently without it:
 * a round that has undelegated, the verification scripts under `scripts/` that deliberately test on
 * the base layer where names survive (`verify-session-base.mjs` exists for exactly that reason), and
 * every future reader who assumes "matches the rollup" implies "matches anything". Both layers, one
 * classifier, or the fix is just the bug pointing the other way.
 *
 * `causedByAccount` is Anchor's own extra line for a CONSTRAINT failure rather than a `require!` —
 * `AnchorError caused by account: session_token.` — which is how a lapsed session names itself on
 * the base layer and is not a shape any `require!` produces.
 */
export function baseLayerError(
  name: string,
  number: number,
  msg: string,
  causedByAccount?: string,
): Error & { transactionMessage?: string; transactionLogs?: string[] } {
  const thrownIn = causedByAccount === undefined
    ? "Program log: AnchorError thrown in programs/bulls-arena/src/lib.rs:1557."
    : `Program log: AnchorError caused by account: ${causedByAccount}.`;
  const logs = [
    "Program ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe invoke [1]",
    "Program log: Instruction: Enter",
    `${thrownIn} Error Code: ${name}. Error Number: ${number}. Error Message: ${msg}.`,
    "Program ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe consumed 7695 of 200000 compute units",
    `Program ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe failed: custom program error: 0x${number.toString(16)}`,
  ];
  const e = new Error(
    `Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n${JSON.stringify(logs)}. `,
  ) as Error & { transactionMessage?: string; transactionLogs?: string[] };
  e.name = "SendTransactionError";
  e.transactionMessage =
    "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x" +
    number.toString(16);
  e.transactionLogs = logs;
  return e;
}
