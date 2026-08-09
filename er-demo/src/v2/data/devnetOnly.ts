// THE DEVNET GUARD, RE-ASSERTED AGAINST A LIVE OBJECT rather than a constant.
//
// `chain/constants.ts` runs `assertDevnetUrl` over `BASE_RPC` and `ROUTER_URL` at import time, which
// covers the endpoints this app writes down. This file covers the ones it might be HANDED. A wallet
// the visitor controls is a new actor in the app, and the question this module answers is the one
// worth asking every time that changes: can a mainnet endpoint reach the running page now?
//
// TODAY IT CANNOT, AND THE REASON IS STRUCTURAL RATHER THAN CAREFUL. The wallet supplies no
// endpoint. We drive `PhantomWalletAdapter` directly and use exactly one method on it —
// `signTransaction` — never `adapter.sendTransaction(tx, connection)`, which is the only place an
// adapter is ever given a `Connection` at all. Every byte this app sends goes out over `BASE_RPC`
// or `ROUTER_URL`, both asserted at import, both devnet. The wallet signs; this page submits.
//
// THE NEAR MISS WORTH NAMING, so nobody "simplifies" us into it later. `@solana/wallet-standard-util`
// exposes `getChainForEndpoint`, which picks a chain by matching `/\bdevnet\b/i` against an endpoint
// STRING and FALLS THROUGH TO `solana:mainnet` for anything it does not recognise. That is a
// fail-OPEN default sitting one dependency away — the precise inverse of this repo's fail-CLOSED
// allowlist (see `devnet-guard.ts`'s header on why a denylist silently permits every endpoint nobody
// thought to ban). It cannot reach us because the classic injected-provider adapter has no chain
// concept and we never hand any adapter a connection. Migrating to the Wallet Standard adapter path
// would put that default in the app's dependency graph, and this comment is the thing that should
// make someone stop and think first.
//
// It is cheap — a regex over a string this app already owns — and it runs where the wallet path
// first touches a connection, so the assertion sits next to the thing it protects rather than in a
// file someone has to remember to look at.

import type { Connection } from "@solana/web3.js";
import { assertDevnetUrl } from "../../devnet-guard.ts";

/**
 * Throws `MainnetBlocked` unless `connection`'s ACTUAL endpoint is one the guard can positively
 * identify as devnet/local.
 *
 * Reads `rpcEndpoint` off the live object rather than trusting the constant it was probably built
 * from: the point of a guard is to check what is true at the moment it runs, not to restate what was
 * true when someone wrote the constant down.
 */
export function assertDevnetConnection(connection: Connection, what = "wallet-path connection"): void {
  assertDevnetUrl(connection.rpcEndpoint, what);
}
