// WHAT THE CHAIN SAID, READ THE SAME WAY ON BOTH LAYERS — one module, because there are two layers
// and they do not word a refusal alike, and every classifier on this page that forgot that was dead
// in production while passing its own tests.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT THIS MODULE EXISTS FOR. Recorded in `entryWindow.ts`'s header from doomed `enter`s
// sent at the deployed program on devnet (v8, ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe), and
// reproduced here because it is now load-bearing for three modules rather than one:
//
//   · BASE LAYER — `simulateTransaction` returns the Anchor log line intact:
//         Program log: AnchorError thrown in .../lib.rs:1557. Error Code: NotInLobby.
//         Error Number: 6002. Error Message: round is not in the lobby phase.
//     The NAME is there, and a name-keyed matcher works.
//
//   · THROUGH THE MAGIC ROUTER INTO THE ER — the path EVERY real `enter`, `extract` and `tick` takes,
//     because a live round is delegated from the moment its lobby opens — `sendRawTransaction` throws
//     a `SendTransactionError` whose entire content is
//         transactionMessage: "solana rpc request error: RPC response error -32003: transaction
//                              verification error: Error processing Instruction 0:
//                              custom program error: 0x1775; "
//         transactionLogs:    undefined
//     No logs. No `Error Code:` line. No name. THE HEX CODE IS THE ONLY SIGNAL THERE IS.
//
// `transactionLogs` is `undefined` rather than `[]`, and the distinction is not pedantry: the
// router's JSON-RPC error carries no `data.logs` at all, so web3.js's `SendTransactionError`
// constructor never receives an array to hold. A matcher that reads `e.logs` finds nothing to read.
//
// THE ER IS NOT A TEST ENVIRONMENT — IT IS THE ONLY ENVIRONMENT. `chain/sendTx.ts` sends every
// browser transaction through `ConnectionMagicRouter` with `skipPreflight: false` and never names an
// endpoint, so the shape above is what `useActions.ts` catches on the real page. A classifier keyed
// on prose therefore fires ONLY where nobody plays. That is not a theoretical gap; it is how
// `isFightBehind` and `walletFault.ts`'s `SESSION_GONE` both came to be unreachable in the
// environment they were written for, each passing a test suite built out of base-layer strings.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// SO: MATCH THE NUMBER, AND GET THE NUMBER FROM SOMETHING THAT CANNOT BE STALE.
//
// `#[error_code]` numbers start at 6000 and SHIFT whenever a variant is inserted above, so a client
// with `6022` written into it silently starts catching a different error the next time the program
// grows one — the objection `useActions.ts` recorded, correctly, when it refused to match numbers at
// all. The answer is not to keep matching names the rollup will never send. It is to stop WRITING
// the number down: `errorCodeOf` reads name → code out of the IDL FETCHED AT RUNTIME
// (`chain/idl.ts`'s `loadIdl`), which is a contract with the DEPLOYED program rather than a memory of
// it. A variant inserted above `FightBehind` moves the number in lib.rs, in the IDL and here
// together, with nothing for anybody to remember.
//
// PURE AND REACT-FREE, like `walletFault.ts`, `entryWindow.ts` and `autoSession.ts`, for the reason
// this project keeps repeating: there is no browser test harness here, so a decision that matters is
// a decision a plain Node test can call. `chainErrorShapes.ts` holds the two shapes above as
// fixtures so all three classifiers are tested against the same captured bytes.

/**
 * Everything readable off a thrown chain error, flattened once.
 *
 * FOUR FIELDS, AND EVERY ONE OF THEM REALLY ARRIVES. `@solana/web3.js`'s `SendTransactionError` puts
 * the RPC's sentence in `transactionMessage` and the simulation logs in `transactionLogs`, and
 * inlines the last ten log lines into `message`; `logs` is its own deprecated accessor for the same
 * array, and is the field `useActions.ts`'s `isFightBehind` used to read alone. On the ER path
 * measured above, only `message`/`transactionMessage` are populated at all. Reading all four costs
 * nothing and is the difference between working in a test and working in the browser.
 *
 * A THROWN STRING IS ALSO A THROWN VALUE. Not everything that throws builds an `Error`, and a caller
 * that had to special-case that would grow a second, worse copy of this function.
 */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e === null || e === undefined || typeof e !== "object") return "";
  const o = e as { message?: unknown; transactionMessage?: unknown; logs?: unknown; transactionLogs?: unknown };
  const parts: string[] = [];
  for (const v of [o.message, o.transactionMessage]) if (typeof v === "string") parts.push(v);
  for (const v of [o.logs, o.transactionLogs]) {
    if (Array.isArray(v)) for (const l of v) if (typeof l === "string") parts.push(l);
  }
  return parts.join("\n");
}

/**
 * Did the chain refuse this with `errorName`, whichever layer answered?
 *
 * THREE ANCHORED FORMS, because the same refusal arrives written three different ways depending on
 * which layer answered — all three observed on devnet, none of them inferred:
 *
 *   `Error Code: NotInLobby.`      the Anchor log line. Base layer only; the router strips logs.
 *   `Error Number: 6002.`          the same log line's other half.
 *   `custom program error: 0x1772` the RPC's own sentence, and ON THE ROLLUP PATH THE ONLY ONE THERE
 *                                  IS. Lower-case hex, hence the case-insensitive match.
 *
 * Each is anchored to its surrounding phrase rather than matched bare: a loose `/6002/` would find a
 * lamport figure, a slot, or half a signature. `\b` on the name so a future `NotInLobbyYet` is not
 * read as this one.
 *
 * `code === undefined` MEANS THE IDL COULD NOT BE READ, and the honest response is to fall back to
 * the name alone rather than to guess a number. That is exactly the pre-rollup behaviour: it refuses
 * nothing that used to work on the base layer, and it gives up on the rollup shape out loud instead
 * of matching whatever happens to be at that index today.
 */
export function failedWith(text: string, errorName: string, code: number | undefined): boolean {
  if (new RegExp(`Error Code: ${errorName}\\b`).test(text)) return true;
  if (code === undefined) return false;
  if (new RegExp(`Error Number: ${code}\\b`).test(text)) return true;
  return new RegExp(`custom program error: 0x${code.toString(16)}\\b`, "i").test(text);
}

/**
 * One error's number, as the DEPLOYED program defines it — or `undefined` where the IDL does not
 * name it.
 *
 * `undefined` IS A REAL ANSWER AND NOT A FAILURE. An IDL that carries no `errors` array, an IDL that
 * could not be fetched at all, and an error belonging to a DIFFERENT crate (`SessionError` lives in
 * session-keys, not in this program's IDL, though this program is what returns it — see
 * `walletFault.ts`) all land here. Every caller degrades to matching the name, which is the whole of
 * what this codebase did before the rollup.
 */
export function errorCodeOf(
  errors: ReadonlyArray<{ name: string; code: number }> | undefined,
  errorName: string,
): number | undefined {
  return errors?.find((e) => e.name === errorName)?.code;
}
