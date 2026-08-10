// PARSING THE ONE PARAMETER `/api/links` TAKES, and refusing everything else.
//
// THERE IS NO ENUMERATION ROUTE (`TWITTER-CONNECT.md` §6.4). An absent `wallets` parameter is an
// error, not "return everything" — and that is a decision about a *default*, which is the kind that
// decides the shape of the thing later. A bulk export nobody meant to build is one missing
// `if (!wallets)` away, it never looks like a bug, and by the time it is noticed the register has
// been scraped. So the parser has no representation for "all": the only success value it can produce
// is a non-empty, bounded, fully validated list.
//
// The register is not secret — anyone can enumerate wallets from chain and ask about them one at a
// time. What this removes is the trivially scrapeable bulk export, which is the difference between
// "someone determined can build this list" and "someone bored already has it".

import { MAX_WALLETS_PER_QUERY } from "../../src/v2/data/xLink.ts";
import { PublicKey } from "@solana/web3.js";

/** Why a wallet list was refused. Goes in a 400 body and in a log line; never near a player. */
export type WalletListRejection =
  | "missing"
  | "empty"
  | "too-many"
  | "not-base58";

/** A STRING DISCRIMINANT, NOT A BOOLEAN, and it is not a style choice.
 *
 *  This repo's tsconfigs do not enable `strict`, so `strictNullChecks` is off — and with it off a
 *  union discriminated by `ok: true | false` does not narrow on the failure branch. `v.reason` is
 *  then a compile error at every call site, and the natural "fix" is a cast, which is how a union
 *  that was supposed to make the failure case impossible to ignore becomes a union that hides it.
 *  `xLink.ts`'s own `Verification` uses `kind` for exactly this reason; matching it means one shape
 *  of result in the whole feature. */
export type WalletList =
  | { readonly kind: "ok"; readonly wallets: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: WalletListRejection; readonly detail: string };

/** Same check `xLink.ts` runs on the way back in: through `PublicKey`, so the base58 ALPHABET and
 *  the decoded LENGTH are both confirmed. A character-class regex passes `1111` and would put a
 *  four-byte "pubkey" into a SQL parameter. */
function isBase58Pubkey(v: string): boolean {
  try {
    return new PublicKey(v).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * `?wallets=<comma-separated base58>`.
 *
 * @param raw the query parameter exactly as it arrived, or `null`/`undefined` when it was not sent.
 *   A repeated parameter (`?wallets=a&wallets=b`) must be collapsed by the caller before it gets
 *   here — an array reaching this function is a caller bug and is rejected as `missing`, because
 *   guessing which copy the client meant is how a parser starts having opinions.
 *
 * VALIDATION HAPPENS BEFORE THE DATABASE IS TOUCHED, all of it. The query is parameterised so a bad
 * wallet is not an injection risk, but "not an injection risk" is not the same as "free": an
 * unvalidated list is an unbounded list, and an unbounded `= ANY($1)` is a way to make one HTTP
 * request cost an arbitrary amount of database.
 */
export function parseWalletList(raw: unknown): WalletList {
  if (typeof raw !== "string") return { kind: "rejected", reason: "missing", detail: "wallets is required" };

  const parts = raw.split(",").map((s) => s.trim());

  // Counted BEFORE de-duplication, deliberately. Deduplicating first would let a caller send ten
  // thousand copies of one wallet and still pass a limit that exists to bound the request, not the
  // result.
  if (parts.length > MAX_WALLETS_PER_QUERY) {
    return { kind: "rejected", reason: "too-many", detail: `at most ${MAX_WALLETS_PER_QUERY} wallets` };
  }
  if (parts.length === 1 && parts[0] === "") {
    return { kind: "rejected", reason: "empty", detail: "wallets is empty" };
  }

  const seen = new Set<string>();
  for (const p of parts) {
    // An empty element (`a,,b`) is a client bug, and skipping it silently means the client keeps
    // shipping it. Refused with the same reason as any other unparseable entry.
    if (!isBase58Pubkey(p)) {
      return { kind: "rejected", reason: "not-base58", detail: "every wallet must be a base58 ed25519 pubkey" };
    }
    seen.add(p);
  }
  return { kind: "ok", wallets: [...seen] };
}
