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
// ONE LOOSE END IN THAT TRANSCRIPTION, LEFT AS IT WAS FOUND RATHER THAN TIDIED. The rollup line
// records `0x1775`, which is 6005 — `BadSide`, not the `NotInLobby` (6002 = `0x1772`) the paragraph
// around it is about; commit b38553d, which added both, quotes both numbers. Most likely the probe
// that produced the rollup capture sent a deliberately invalid `side` while the base-layer one sent a
// late deposit, i.e. two different doomed transactions illustrating one shape. Nothing in the repo
// settles it, and NOTHING IN THIS MODULE DEPENDS ON IT: what is reused is the SHAPE — the wrapper
// text, the absent logs, the `custom program error: 0x…` form — and every consumer supplies its own
// number. It is written down because a reader who spots it should find it already noticed rather than
// conclude the capture was invented.
//
// A SECOND, INDEPENDENT RUN CORROBORATES THE SHAPE, which matters more than the loose end above.
// `scripts/verify-house-take.ts`'s non-authority negative control ran green on the ER (commit
// 6831d11: "a non-authority attempt against that same still-open lobby was refused with
// NotTheAuthority") — and that script's `anchorErrorCode` tries `AnchorError`, then
// `Error Code: (\w+)\.`, and only then `custom program error: 0x([0-9a-fA-F]+)` against the IDL's
// error table. The first two find nothing on the rollup, so that assertion could only have passed
// through the hex path. A green test proves the shape here, not just a comment.
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
// (`chain/idl.ts`'s `loadIdl`), so a variant inserted above `FightBehind` moves the number in lib.rs,
// in the IDL and here together.
//
// AND THERE IS EXACTLY ONE THING LEFT TO REMEMBER, which an earlier draft of this paragraph claimed
// there was not. `loadIdl()` fetches `public/idl/bulls_arena.json` — a CHECKED-IN file, not the
// on-chain IDL account. `scripts/idlgen.py` writes it and the Rust from one body and its `--verify`
// pass checks that every error code matches its declaration position, so the two normally cannot
// drift; but its refuse-to-write guard covers the `Round` LAYOUT, and `--deployed-check` compares
// account sizes. An in-place upgrade that renumbered errors and was not followed by a republish would
// desync silently. So the honest claim is "one step, in `idlgen.py --deploying`", not "none".
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
 * A NAME, WHERE THERE IS ONE, IS THE LAST WORD — and this is not the obvious reading of "three forms,
 * any of which will do". The three do not arrive one at a time: on the base layer ALL THREE are in
 * the same text, because Anchor's log line carries the name and the number together and the RPC's
 * sentence carries the hex. So an unconditional OR lets the NUMBER speak for an error the NAME has
 * already identified as something else — and the numbers collide across crates. `SessionError::
 * InvalidToken` and `ArenaError::RoundOutOfOrder` are both 6001 and both `0x1771`, so
 * `failedWith(text, "InvalidToken", 6001)` over a base-layer `RoundOutOfOrder` log would match on its
 * `Error Number: 6001.` half while the same line says `Error Code: RoundOutOfOrder.` two words
 * earlier. That would throw away the exact disambiguation `verify-session-base.mjs` calls "the whole
 * point of the helper", on the one layer where it exists.
 *
 * So: if the text names an error at all, the answer is whether it names THIS one. The number is
 * consulted only where there is no name to consult — which is the rollup, and is why the number is
 * here at all.
 *
 * `code === undefined` MEANS THE IDL COULD NOT BE READ, and the honest response is to fall back to
 * the name alone rather than to guess a number. That is exactly the pre-rollup behaviour: it refuses
 * nothing that used to work on the base layer, and it gives up on the rollup shape out loud instead
 * of matching whatever happens to be at that index today.
 */
export function failedWith(text: string, errorName: string, code: number | undefined): boolean {
  // `\w+` rather than the name interpolated, precisely so the name that IS there can DISAGREE. A
  // `RegExp(\`Error Code: ${errorName}\`)` can only ever say "yes" or "no idea", and "no idea" then
  // falls through to the number — which is the hole above.
  const named = /Error Code: (\w+)/.exec(text);
  if (named !== null) return named[1] === errorName;
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
