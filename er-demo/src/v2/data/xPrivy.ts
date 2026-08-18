// THE LOGIN TRIGGER — the piece `xProof.ts` was written around and could not yet call.
//
// `xProof.ts` is the READER: it knows what artefact the server accepts and hands it over verbatim.
// This file is the WRITER'S TRIGGER: it makes that artefact exist, by sending the player to Privy,
// having them authorise X, and coming back. It owns the only Privy SDK import in this program.
//
// It exports ONE call — `identityTokenViaPrivy()` — and it never throws a domain error and never
// returns `null` to mean two things. It returns an OUTCOME, and `xProof.ts` turns that outcome into
// the `string | null | throw` contract the ceremony already understands. That split is not ceremony
// for its own sake; see "WHY AN OUTCOME RATHER THAN A THROW" below.
//
// ================================================================================================
// WHY `@privy-io/js-sdk-core` AND NOT `@privy-io/react-auth`.
//
// `react-auth` is the documented package and it is ~628 KB gzip with 42 dependencies — viem,
// WalletConnect and the Coinbase SDK are HARD dependencies of it even for an app that never touches
// Ethereum. `js-sdk-core` is the vanilla client underneath it, and it is what the previous build
// already used against this same Privy app (`web/index.html:2869-2875`, loaded from esm.sh) — so it
// is not an untested choice here, it is the one with production evidence behind it.
//
// It is also the only one of the two that fits this seam. `react-auth` is a React context: it wants
// `<PrivyProvider>` at the app root, which puts an identity SDK in the MAIN chunk for every visitor,
// including the large majority who never link anything (`TWITTER-CONNECT.md` §8 — "the unlinked path
// is the main path"). `useXCeremony.ts` exists in its current shape specifically to avoid that.
//
// `js-sdk-core` IS UNDOCUMENTED FOR DIRECT USE, so everything this file assumes about it was read out
// of the shipped package rather than out of a blog post. The claims that matter, and where each was
// verified in `node_modules/@privy-io/js-sdk-core/dist/`:
//
//   * `new Privy({appId, storage})` is the whole construction. `dts/index.d.mts` `PrivyOptions`; the
//     `crypto` option defaults to `globalThis.crypto.subtle` (`esm/index.mjs`, `function It(e)`), so
//     WebCrypto is used without being passed.
//   * `auth.oauth.generateURL(provider, redirectURI)` does the PKCE leg — it generates the verifier
//     and state, stores them under `privy:code_verifier` / `privy:state_code`, and returns `{url}`.
//   * `auth.oauth.loginWithCode(code, state, provider)` completes it, checks the returned state
//     against the stored one (throwing `pkce_state_code_mismatch` if they differ), and writes the
//     token set to storage.
//   * `getIdentityToken()` is a standalone method on the client — no hook, no React — which is
//     exactly the accessor `xProof.ts`'s header predicted the SDK would bring.
//   * `user.get()` calls the session refresh internally (`esm/index.mjs`, `qn=class{...async get(){
//     let{user:e}=await this._privyInternal.refreshSession()...`), which re-mints the identity token.
//     That is load-bearing here; see "FRESHNESS" below.
//   * Logging in does NOT drag in an embedded wallet. The post-login step defaults `createOnLogin` to
//     `off` for both chains and returns the response untouched (`esm/index.mjs`, `Z=async(e,t,n)=>`),
//     so no wallet iframe, no message poster, and no `supportedChains` are needed.
//
// ================================================================================================
// THE VERSION IS PINNED EXACTLY — `"0.69.0"`, NO CARET — AND THAT IS NOT TIDINESS.
//
// `@privy-io/js-sdk-core` 0.69.1 and 0.70.0 both ship CONTRADICTORY PEER DECLARATIONS: they ask for
// `viem` at one exact version (`2.55.13` and `2.55.15` respectively) while their own dependency
// `@privy-io/ethereum@0.2.2` asks for exactly `2.55.10`. No version of viem satisfies both, so `npm
// install` refuses the tree outright with `ERESOLVE ... Conflicting peer dependency: viem`.
//
// THIS REPOSITORY USES TWO PACKAGE MANAGERS AND THEY DISAGREE ABOUT THAT. `vercel.json` runs `npm ci`
// at the monorepo root and `bun install --frozen-lockfile` in here; `er-demo/package-lock.json` is
// gitignored and `bun.lock` is the one that ships. Bun does not enforce peer ranges, so a caret range
// floats silently to a version npm cannot install — which means a developer running `npm install`
// before `npx vitest run` hits a wall that CI never sees.
//
// 0.69.0 is the most recent version whose peers agree with themselves. Pinning it makes both managers
// resolve the same tree. WHEN YOU BUMP IT, check the two `viem` lines first:
//
//     npm view @privy-io/js-sdk-core@<next> peerDependencies.viem dependencies.@privy-io/ethereum
//     npm view @privy-io/ethereum@<that> peerDependencies.viem      # the two must match
//
// ================================================================================================
// POPUP, NOT FULL-PAGE REDIRECT — AND THIS IS THE DECISION THE REST OF THE FILE IS SHAPED BY.
//
// The previous build redirected: `location.href = url`, then read `privy_oauth_code` off the query
// string on the way back in (`web/index.html:2894-2937`). That works, and it is why the parameter
// names below are known to be right rather than guessed.
//
// It cannot be used here. `runLink` in `xLinkCeremony.ts` is a single promise: it gets a proof, then
// asks the wallet to sign, then redeems. A full-page navigation destroys that promise along with the
// page, so a redirect flow could only ever resolve on a LATER press — the player would authorise X,
// come back, and have to press `Connect X` a second time to be asked for a signature they thought
// they had already started. Worse, it makes two things unreachable that the code around this already
// promises:
//
//   * `FAILURE_COPY.cancelled` is "You cancelled before X confirmed." — a sentence about a WINDOW the
//     player closed. With a redirect there is no window to close and no way to observe them not
//     coming back.
//   * `runLink`'s single retry for a stale proof calls `getProof()` a second time in the same page
//     life. A redirect flow has no second call; the page is gone.
//
// So: a popup, and the token comes back inside the promise the ceremony is already awaiting.
//
// THE PRICE OF A POPUP IS THE USER-ACTIVATION RULE, and it is paid for deliberately rather than
// hoped through. `window.open` needs a live user activation. Chrome and Firefox keep that activation
// for ~5 s across `await`s, so a network round trip in between is survivable; SAFARI DOES NOT — it
// ties the call to the gesture's own task, and an intervening network fetch loses it. This file is
// therefore ordered so that on the path that actually needs a window — a player who has never
// authorised X — NOTHING BUT MICROTASKS runs between the press and `window.open`:
//
//     press -> await import("./xProof.ts")   <- warm, because `ConnectPanel.tsx` preloads this chunk
//                                               when the consent dialog opens, several seconds earlier
//           -> getIdentityToken()            <- localStorage only, resolves in a microtask
//           -> window.open()                 <- activation intact
//
// The two paths that do run a network call first are the ones that do not normally need a window at
// all (a live session) or are already degraded (a session that will not refresh), and both are
// handled where they arise rather than left to fail as a blocked popup.
//
// ================================================================================================
// FRESHNESS, WITHOUT PARSING THE TOKEN.
//
// The server refuses an identity token whose `iat` is more than an hour old (`api/src/
// privyIdentity.ts`), and `xProof.ts` forbids this half from parsing the token at all — a second
// opinion about the artefact is a second place for the two halves to disagree. Those two rules look
// like they conflict: how do you avoid handing over a stale token without looking at its age?
//
// You re-mint it. When a session already exists, this file calls `user.get()`, whose refresh writes a
// newly issued identity token to storage, and returns THAT. The token is then seconds old by
// construction, and nothing here has read a claim out of it. The alternative — decoding the payload
// to check `iat` — would put the server's rule in two places, and the version in the browser would be
// the one nobody notices going stale.
//
// It also makes `runLink`'s retry work. That retry only re-sends if the second proof DIFFERS from the
// first (`xLinkCeremony.ts`: `if (refreshed === null || refreshed === proof) return first`), so a
// `getProof()` that returned the same cached string twice would silently disable it.
//
// ================================================================================================
// WHY AN OUTCOME RATHER THAN A THROW.
//
// `xProof.ts` owns a distinction the ceremony depends on and that is easy to destroy from here: a
// player who closed the X window is `cancelled`, and a misconfigured app is `unavailable`, and they
// are told different things. That distinction is carried by `null` vs `ProofUnavailableError`, and
// `xLinkCeremony.ts` matches the error BY NAME because importing the class as a value would pull this
// chunk into the main bundle.
//
// If this file threw its own errors, every SDK failure — a network blip inside `generateURL`, a
// storage permission, a state mismatch — would arrive at `runLink`'s `catch` as "not
// ProofUnavailableError", which it reads as `cancelled`. A player would be told they cancelled
// something they never got the chance to cancel. Returning an explicit outcome makes the mapping a
// visible decision in one function (`xProof.ts#proofFromOutcome`) instead of an accident of which
// error class happened to escape.
//
// ================================================================================================
// REJECTED ALTERNATIVES.
//
//   *Have the popup `postMessage` the code back to the opener.* Rejected: the opener must poll
//   `popup.closed` anyway — that is the only way to notice a player closing the window, which is the
//   `cancelled` outcome — so a message listener would be a SECOND completion mechanism racing the
//   first, with its own origin check to get wrong and its own listener to leak. Reading
//   `popup.location.search` from the same poll needs no script in the callback page at all, which is
//   why `public/x-callback.html` is markup only.
//
//   *Point `redirect_to` at the app itself, as the previous build did (`location.origin +
//   location.pathname`).* Rejected: the popup would boot a second copy of the whole game — PIXI, the
//   particle system, a second wallet adapter — inside a 480x720 window, for the two seconds it takes
//   to read two query parameters off it. `public/x-callback.html` is a static file with no script and
//   no bundle entry; Vite copies it verbatim and no chunk graph is involved.
//
//   *Read `privy_oauth_code` out of the popup's PATH and require it to be our callback page.*
//   Rejected: `vercel.json` sets `cleanUrls: true`, so `/x-callback.html` is served in production as
//   a 301 to `/x-callback` while Vite's dev server serves the literal `.html` path. The pathname
//   therefore differs between dev and production for the same file. The query parameter does not, and
//   it is the thing we actually need, so it is the thing that is matched on.
//
//   *Reach into `localStorage` and delete Privy's keys when a session will not refresh.* Rejected:
//   that is one library's private storage layout being edited by another, and the layout is already
//   the thing this feature had wrong (see `xProof.ts#identityTokenKeys`). The one-line in-memory
//   `sessionRefreshFailed` below achieves the same repair without touching anything we do not own.
// ================================================================================================

import Privy, { LocalStorage } from "@privy-io/js-sdk-core";

/**
 * The provider id Privy knows X by. `twitter`, not `x` — Privy's `ExternalOAuthProviderID` union
 * (`@privy-io/api-types`) has never been renamed, and the linked-account type it produces is
 * `twitter_oauth`, which is the string `api/src/privyIdentity.ts` looks for in the token's
 * `linked_accounts` claim. Both spellings are Privy's; neither is ours to modernise.
 */
const X_PROVIDER = "twitter";

/**
 * The linked-account type that means "this Privy user controls an X account".
 *
 * THE SAME STRING THE SERVER MATCHES ON (`api/src/privyIdentity.ts:384`). It is repeated rather than
 * shared because the two halves are separate deployables that must be able to disagree loudly rather
 * than drift together silently — but it is repeated ONCE, here, with the other half named.
 */
const X_LINKED_ACCOUNT = "twitter_oauth";

/**
 * Where Privy sends the popup back to. A static file (`public/x-callback.html`) with no script in it.
 *
 * The `.html` is written out because that is the literal file, and Vite's dev server serves public
 * assets at their literal path. Production adds a redirect on top of it (`vercel.json`'s `cleanUrls`)
 * and nothing here depends on which of the two the popup ends up sitting on — see the rejected
 * alternative about matching on the path.
 */
export const X_CALLBACK_PATH = "/x-callback.html";

/** The query parameters Privy appends to `redirect_to`. Not invented here: these are the names the
 *  previous build already read successfully from this same Privy app (`web/index.html:2911`). */
const CODE_PARAM = "privy_oauth_code";
const STATE_PARAM = "privy_oauth_state";

/** How often the opener looks at the popup. Fast enough that closing the window feels like it was
 *  noticed, slow enough to be free — this is a property read on a window, not a network call. */
const POLL_INTERVAL_MS = 200;

/**
 * How long the popup may sit unanswered before we give up on it.
 *
 * Generous on purpose: a player who is not signed in to X has to sign in, possibly through a second
 * factor, possibly on a password manager's schedule. Five minutes is long enough that the timeout is
 * never the thing that ends a real attempt, and short enough that a player who wandered off does not
 * leave `Connect X` disabled (`useXCeremony.ts` holds `busy` for the whole ceremony) for ever.
 */
const AUTHORISE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Popup geometry. X's authorisation page is a narrow single-column form; this is enough for it
 * without covering the page the player is trying to come back to.
 *
 * `noopener` IS DELIBERATELY ABSENT. It is the right default almost everywhere else — it is what
 * stops an untrusted page reaching back into ours — but here the opener relationship IS the channel:
 * without it `popup.closed` and `popup.location` are both unreadable and there is no way to tell a
 * completed authorisation from a closed window. What we open is Privy's own auth origin, and nothing
 * from that window is read except two query parameters that are useless without the PKCE verifier
 * this browser is holding.
 */
const POPUP_FEATURES = "popup=yes,width=480,height=760";

/** Naming the window means a second press REUSES it rather than opening a second one — a player who
 *  pressed twice gets one X window, which is also the one they will close. */
const POPUP_NAME = "privy-x-authorisation";

/**
 * What happened, in the three shapes the ceremony can actually act on.
 *
 * `unavailable` carries a sentence for the CONSOLE, not for a player — `xConsent.ts#FAILURE_COPY`
 * owns every word anybody reads, and deliberately says one thing for every failure of this kind.
 * `why` exists so that the operator who has to fix it can see which of them it was.
 */
export type PrivyProofOutcome =
  /** A token, verbatim, exactly as Privy issued it. */
  | { readonly kind: "proof"; readonly token: string }
  /** The player closed the X window, or never finished with it. Not an error. */
  | { readonly kind: "cancelled" }
  /** Nothing a player did and nothing they can fix. `why` names the cause for the console. */
  | { readonly kind: "unavailable"; readonly why: string };

/**
 * The minimum this file needs to know about a Privy user, written out rather than imported.
 *
 * `@privy-io/api-types` is a TRANSITIVE dependency — it arrives under `@privy-io/js-sdk-core` and is
 * not declared in our `package.json`. Importing types from it directly would make this file depend on
 * a package nothing here installed, which breaks the day the SDK bumps it. Structural typing gives us
 * the one field we read with none of that.
 */
interface UserWithLinkedAccounts {
  readonly linked_accounts?: readonly { readonly type?: unknown }[];
}

/**
 * Does this Privy user control an X account?
 *
 * PURE, AND EXPORTED FOR THAT REASON — this repository's discipline is that decisions live in pure
 * functions `npx vitest run` can reach without a DOM (`xProof.test.ts` says so at the top).
 *
 * WHY THE QUESTION IS ASKED AT ALL. A live Privy session is not the same thing as a proven X account.
 * In this app they coincide, because X login is the only method we ever invoke — but if they ever
 * came apart, handing the server a token with no `twitter_oauth` entry earns a `no-x-account`
 * refusal, which `xLinkCeremony.ts` maps to `cancelled`, which tells a player who never saw a popup
 * that they closed one. Checking here costs nothing (the user object is already in hand from the
 * refresh) and the remedy is the one thing that can actually help: run the login.
 *
 * THIS IS NOT THE SERVER'S CHECK AND MUST NOT GROW INTO IT. The server verifies the signature and
 * requires a usable `subject` and `username` inside the SIGNED token (`api/src/privyIdentity.ts`).
 * This looks at the unsigned user object the SDK just fetched, and only to decide whether to open a
 * window. If the two ever disagree the server wins, as it does everywhere else in this feature.
 */
export function hasXAccount(user: UserWithLinkedAccounts | null | undefined): boolean {
  if (user === null || user === undefined) return false;
  const accounts = user.linked_accounts;
  if (!Array.isArray(accounts)) return false;
  return accounts.some((account) => account?.type === X_LINKED_ACCOUNT);
}

/**
 * The authorisation code and state Privy handed back, or `null` if this is not a completed callback.
 *
 * PURE, and the only parsing in the OAuth leg. Both parameters are required together: the state is
 * what `loginWithCode` compares against the value it stored before the redirect, and a code without
 * one cannot be redeemed at all.
 *
 * NEITHER VALUE IS A TOKEN. The code is a single-use authorisation code that is worthless without the
 * PKCE verifier sitting in this browser's own storage — which is the entire point of PKCE, and the
 * reason this can be read off a URL in a window we do not fully control.
 *
 * AN EMPTY OR ABSENT PAIR IS NOT AN ERROR HERE. It is what every poll sees while the player is still
 * on X, and it is also what a denial looks like when Privy sends the window back without a code.
 */
export function callbackParams(search: string): { code: string; state: string } | null {
  if (typeof search !== "string" || search === "") return null;

  // NO `try` AROUND THIS. `new URLSearchParams(aString)` does not throw for any string — a lone `%`
  // and other malformed escapes are passed through rather than rejected, unlike `decodeURIComponent`,
  // which is why `proofFromCookie` in `xProof.ts` needs a guard here and this does not. A `catch`
  // would read as if there were a failure mode to catch.
  const params = new URLSearchParams(search);

  // `URLSearchParams` decodes `+` as a space, which would corrupt a code containing a literal `+`.
  // Privy percent-encodes (`%2B`), and this exact parser read this exact app's callbacks in the
  // previous build (`web/index.html:2911`), so the case is not reachable — written down because the
  // rule in this file is that assumptions get written down rather than relied on quietly.
  const code = params.get(CODE_PARAM);
  const state = params.get(STATE_PARAM);
  if (code === null || code === "" || state === null || state === "") return null;
  return { code, state };
}

/**
 * The app id this build was compiled against, trimmed, or `null`.
 *
 * PURE. `VITE_PRIVY_APP_ID` is inlined at build time and is genuinely absent in some environments —
 * a local `npm run dev` with no `.env`, a branch deploy that predates the variable. Without it the
 * SDK cannot be constructed at all, and that is a build fault worth naming precisely rather than
 * discovering as a stack trace from inside the SDK.
 *
 * It is the same value the server compares every token's `aud` against; `api/src/writeEnv.ts` accepts
 * it under this name for exactly that reason.
 */
export function appIdOf(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * ONE CLIENT PER PAGE LIFE.
 *
 * Not for speed — for correctness. `generateURL` writes the PKCE verifier and state through the
 * client's `storage`, and `loginWithCode` reads them back. Both calls have to see the same store, and
 * a second `new Privy(...)` between them with a different `Storage` instance would look exactly like
 * the phishing attempt the SDK's state check exists to catch (`pkce_state_code_mismatch`).
 *
 * `LocalStorage` is the SDK's own implementation and is used rather than a hand-rolled one so that
 * the layout stays Privy's business. Note what it does: it JSON-encodes every value, which is why the
 * raw fallback read in `xProof.ts` has to tolerate a quoted string.
 */
let client: Privy | null = null;

function privyClient(appId: string): Privy {
  client ??= new Privy({ appId, storage: new LocalStorage() });
  return client;
}

/**
 * Set once a session refresh has failed in this page's life.
 *
 * WHAT IT REPAIRS. The refresh throws when the stored credentials are incomplete — an identity token
 * with no refresh token beside it, which is what a partially cleared storage looks like. In that
 * state the SDK does NOT clear anything (the throw happens before the branch that would), so every
 * press would take the same doomed network round trip and then try to open a popup with the user
 * activation already spent — the one ordering this file exists to avoid.
 *
 * Remembering the failure for the rest of the page's life sends the next press straight to the login,
 * where the window opens with the activation intact. In memory only: a reload re-asks, because a
 * reload is also how a player fixes storage problems.
 */
let sessionRefreshFailed = false;

/**
 * A message for the console, from something the SDK threw.
 *
 * NEVER INCLUDES A TOKEN, and cannot: every call this wraps (`generateURL`, `loginWithCode`,
 * `user.get()`) runs before this browser holds a token from it. The message is still narrowed to
 * `error.message` rather than the error object, because a `PrivyApiError` carries the whole response
 * and this string goes to a console that people paste into issues.
 */
function reasonOf(error: unknown, prefix: string): string {
  const detail = error instanceof Error && error.message !== "" ? error.message : "unknown error";
  return `${prefix}: ${detail}`;
}

/**
 * How long the session refresh may take before the login is started without waiting for it.
 *
 * MEASURED, NOT GUESSED. Driven against the real Privy app with a stored token and no session behind
 * it, `user.get()` took ELEVEN SECONDS to fail — the SDK wraps its requests in `fetch-retry` and
 * spends the whole retry budget before it gives up. For eleven seconds the player had pressed
 * `Connect X` and nothing whatsoever had appeared, and only then did the window open. In Safari it
 * would not have opened at all: the user activation `window.open` needs is long gone by then.
 *
 * A healthy refresh is one round trip and lands inside this comfortably, so the normal path is
 * untouched. What this bounds is the broken path, and on the broken path the login we fall through to
 * supersedes whatever the refresh would eventually have said anyway.
 */
const REFRESH_PATIENCE_MS = 2_500;

/** What the session refresh produced, including "it is still thinking and we are not waiting". */
type RefreshResult =
  | { readonly kind: "user"; readonly user: UserWithLinkedAccounts }
  /** The session is definitively no good. Durable — worth remembering. */
  | { readonly kind: "rejected"; readonly why: string }
  /** It did not work THIS TIME. Says nothing about the session. Never remembered. */
  | { readonly kind: "unreachable"; readonly why: string }
  | { readonly kind: "slow" };

/**
 * Did the refresh fail because the SESSION is no good, or because THIS ATTEMPT was?
 *
 * THE DISTINCTION DECIDES WHETHER WE REMEMBER IT, and getting it wrong in the permissive direction
 * costs a page. `sessionRefreshFailed` is only cleared by a successful login, so latching it on a
 * one-second network blip means every later press on that page opens a full X authorisation window
 * for a player who is already signed in and whose refresh would now succeed perfectly well. The
 * documented purpose of the latch is the OTHER case — credentials that will never work — and this is
 * what keeps it to that case.
 *
 * `status === 401` IS THE SIGNAL, and it is the SDK's own. `_refreshSession` throws a `PrivyApiError`
 * with `status: 401` both when the stored credentials are incomplete (`MISSING_OR_INVALID_TOKEN`,
 * "No tokens found in storage") and when Privy rejects the refresh token it was given. Everything
 * else — a 5xx, a dropped connection, a `TypeError` from `fetch` — is this attempt failing, not the
 * session.
 *
 * DUCK-TYPED RATHER THAN `instanceof PrivyApiError`, because the shape (`{status}`) is the stable
 * part of that contract and the class identity is the part that moves when the SDK is bumped or
 * re-bundled. A missing `status` reads as transient, which is the safe direction: the cost of not
 * latching is one bounded wait, and the cost of latching wrongly is the whole page.
 */
export function refreshRejectedTheSession(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { status?: unknown }).status === 401;
}

/**
 * Refresh the session, but not for longer than a player will sit still for.
 *
 * `slow` AND `failed` ARE DELIBERATELY DIFFERENT OUTCOMES even though both fall through to the login,
 * because only one of them is worth remembering. A refresh that THREW has told us something durable —
 * these credentials do not work — and latching that (`sessionRefreshFailed`) is what stops the next
 * press repeating the same doomed wait. A refresh that was merely SLOW has told us nothing about the
 * credentials, and latching it would downgrade every later press on that page for a player whose
 * session is perfectly good and whose network hiccuped once.
 *
 * The abandoned request is left to finish on its own. It cannot do harm: the only thing it writes is a
 * fresher token set, and the login that follows overwrites that with a fresher one still.
 */
async function refreshedUser(privy: Privy): Promise<RefreshResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const patience = new Promise<RefreshResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "slow" }), REFRESH_PATIENCE_MS);
  });

  // `.catch` on the request itself rather than around the race: a rejection that arrives AFTER the
  // race has been settled by the timer would otherwise be an unhandled rejection, which some browsers
  // report to the console as an uncaught error and every operator reads as a bug.
  const refresh = privy.user
    .get()
    .then((result): RefreshResult => ({ kind: "user", user: result.user }))
    .catch((error: unknown): RefreshResult => {
      const why = reasonOf(error, "the Privy session did not refresh");
      return refreshRejectedTheSession(error)
        ? { kind: "rejected", why }
        : { kind: "unreachable", why };
    });

  try {
    return await Promise.race([refresh, patience]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a poll of the popup found. */
type PopupResult =
  | { readonly kind: "returned"; readonly code: string; readonly state: string }
  /** The player closed the window. Direct evidence that a person acted. */
  | { readonly kind: "closed" }
  /** Back on our origin, carrying something that is not an authorisation. A fault, not a choice. */
  | { readonly kind: "stranded"; readonly params: string }
  /** Five minutes with no answer. Evidence of nothing, which is why it is reported as nothing. */
  | { readonly kind: "timeout" };

/**
 * The NAMES of the parameters a stranded callback carried, comma-separated.
 *
 * NAMES ONLY, NEVER VALUES, and that is not paranoia about this particular branch — by construction
 * this branch has no `privy_oauth_code` in it, or `callbackParams` would have matched. It is that a
 * diagnostic which prints whatever a redirect happened to carry is a diagnostic that will one day
 * print something it should not, and the names are the whole of what is useful anyway.
 */
export function paramNames(search: string): string {
  try {
    return [...new URLSearchParams(search).keys()].join(", ");
  } catch {
    return "unreadable";
  }
}

/**
 * Watch the popup until it comes back to our origin carrying a code, or the player closes it.
 *
 * READING `popup.location` THROWS FOR MOST OF THIS, and that is the normal case rather than an error:
 * while the window is on `auth.privy.io` or `x.com` it is cross-origin and every property access on
 * its location is a `SecurityError`. The `catch` is the "still out there" branch, not a failure
 * branch — which is why it is empty and why that emptiness is deliberate.
 *
 * `popup.closed` IS READABLE THROUGHOUT — it is one of the handful of cross-origin-accessible
 * properties — and it is the only signal a player closing the window produces.
 */
async function awaitPopup(popup: Window): Promise<PopupResult> {
  const deadline = Date.now() + AUTHORISE_TIMEOUT_MS;

  for (;;) {
    if (popup.closed) return { kind: "closed" };

    try {
      const search = popup.location.search;
      const found = callbackParams(search);
      if (found !== null) return { kind: "returned", ...found };

      // BACK ON OUR ORIGIN CARRYING SOMETHING THAT IS NOT AN AUTHORISATION. The window we opened
      // starts on our own callback page with an EMPTY query, so an empty search here is the ordinary
      // "not started yet" state and must keep waiting. A NON-empty one is the round trip having come
      // back with something else — an error parameter, a truncated redirect — and waiting five more
      // minutes for a code that has already not arrived would end in `cancelled`, telling a player
      // they closed a window that is still sitting open in front of them.
      if (search !== "") return { kind: "stranded", params: paramNames(search) };
    } catch {
      // Cross-origin: the player is still on Privy's or X's side of the round trip.
    }

    if (Date.now() >= deadline) return { kind: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Run the OAuth round trip and return whatever it produced.
 *
 * THE WINDOW IS OPENED FIRST, before `generateURL`'s network call, and that ordering is the whole
 * reason this is a separate function — see the user-activation section in this file's header. It is
 * opened onto our own callback page rather than `about:blank` so that the player sees a sentence
 * instead of a white rectangle during the moment before X loads, and so that the first poll reads a
 * same-origin location with no code in it rather than something browsers disagree about.
 */
async function runOAuth(privy: Privy): Promise<PrivyProofOutcome> {
  const redirectURI = `${window.location.origin}${X_CALLBACK_PATH}`;

  const popup = window.open(redirectURI, POPUP_NAME, POPUP_FEATURES);
  if (popup === null || popup.closed) {
    // A blocked popup is NOT `cancelled`. The player pressed the button and nothing appeared; telling
    // them they cancelled would be blaming them for their browser's decision, and telling them to try
    // again in a minute at least matches what a second press (with the activation intact) may fix.
    return {
      kind: "unavailable",
      why:
        "the browser blocked the X authorisation window. This is usually a popup blocker, or a "
        + "user activation that expired before the window could be opened.",
    };
  }

  let url: string;
  try {
    const generated = await privy.auth.oauth.generateURL(X_PROVIDER, redirectURI);
    url = generated.url;
  } catch (error) {
    popup.close();
    // The likeliest cause by a distance is the Privy dashboard's `allowed_domains` not containing
    // this origin — `https://*.vercel.app` CANNOT be allowlisted at Privy, so every preview
    // deployment fails exactly here. `er-demo/api/README.md` lists the setting.
    return {
      kind: "unavailable",
      why: reasonOf(
        error,
        `Privy would not start the ${X_PROVIDER} flow for ${redirectURI} (check the app's `
          + `allowed_domains)`,
      ),
    };
  }

  if (typeof url !== "string" || !/^https:\/\//.test(url)) {
    popup.close();
    return { kind: "unavailable", why: "Privy's OAuth init returned no usable authorisation URL." };
  }

  // `replace` rather than an assignment: the callback page must not become a history entry the
  // player can press Back into after the window has done its job.
  popup.location.replace(url);

  const result = await awaitPopup(popup);

  if (result.kind === "stranded") {
    // A FAULT, NOT A CHOICE — the window came back to us carrying something that is not an
    // authorisation, which nobody at the keyboard did and nobody at the keyboard can fix.
    popup.close();
    return {
      kind: "unavailable",
      why:
        `the X authorisation came back to ${X_CALLBACK_PATH} without an authorisation code `
        + `(parameters: ${result.params === "" ? "none" : result.params}).`,
    };
  }

  if (result.kind !== "returned") {
    // A closed window and an abandoned one are the same event from the player's side, and
    // `FAILURE_COPY.cancelled` is the sentence for both. A timeout also closes the window, because
    // leaving a dead OAuth window open is a worse outcome than closing one somebody forgot about.
    //
    // THE TWO ARE LOGGED APART EVEN THOUGH THEY REPORT THE SAME, because "they closed it" and "we
    // gave up after five minutes with the window still open" are different things to be told when
    // somebody asks why a link did not happen, and the outcome alone cannot say which it was.
    if (result.kind === "timeout") {
      popup.close();
      console.debug(
        `[xlink] the X authorisation window was still open and unanswered after `
          + `${Math.round(AUTHORISE_TIMEOUT_MS / 1000)}s; treating it as abandoned.`,
      );
    }
    return { kind: "cancelled" };
  }

  // Closed before the exchange, not after: the exchange is a request of ours and the window has
  // nothing left to do. Leaving it open until the ceremony finishes would put a stray window over
  // the wallet prompt that comes next.
  popup.close();

  try {
    await privy.auth.oauth.loginWithCode(result.code, result.state, X_PROVIDER);
    // THE SESSION IS GOOD AGAIN, so the next call must not take this branch a second time.
    //
    // Without this line there is a real double-popup: `runLink` calls `getProof()` TWICE when the
    // first attempt fails with `unavailable` (`xLinkCeremony.ts` — the retry that exists for a stale
    // proof, which cannot tell a stale proof from any other outage). If the flag were still set from
    // a refresh that failed BEFORE this login, that second call would skip the refresh it can now
    // do perfectly well and open another X window on top of the ceremony.
    sessionRefreshFailed = false;
  } catch (error) {
    // Includes `pkce_state_code_mismatch`, which the SDK raises when the state that came back is not
    // the one it stored. That is not a player error and it is not transient — it means two flows
    // raced in one browser, or something rewrote the URL — so it is `unavailable` with a reason,
    // not `cancelled`.
    return { kind: "unavailable", why: reasonOf(error, "Privy refused the authorisation code") };
  }

  return tokenOutcome(privy);
}

/**
 * The stored identity token as an outcome — including the case where there is none, which is the
 * configuration fault this whole feature has been blocked on.
 *
 * `getIdentityToken()` RETURNING `null` AFTER A SUCCESSFUL LOGIN IS THE DASHBOARD TOGGLE. "Return
 * user data in an identity token" is OFF by default on a Privy app, and while it is off Privy issues
 * no identity token at all — the login works perfectly, the user exists, and the artefact the server
 * needs is simply never minted. `er-demo/api/README.md` lists it first among the settings that cannot
 * be set from this repo, and `xProof.ts` has warned about it since before there was a login to fail.
 */
async function tokenOutcome(privy: Privy): Promise<PrivyProofOutcome> {
  // WRAPPED, BECAUSE THIS READ CAN THROW, and an earlier version of this file said it could not.
  // `getIdentityToken()` is `JSON.parse(localStorage.getItem(key))` underneath
  // (`dist/esm/index.mjs`, `LocalStorage.get`), so it throws on storage a browser will not open
  // (Safari's Lockdown mode, a hardened profile) and on a half-written value. Unwrapped, that throw
  // escapes this whole module — and `xLinkCeremony.ts` reads any escaped error that is not
  // `ProofUnavailableError` as the PLAYER CANCELLING. A storage fault would have been reported as
  // somebody's choice, which is the one inversion this feature is built to prevent.
  let token: string | null;
  try {
    token = await privy.getIdentityToken();
  } catch {
    token = null;
  }
  if (typeof token === "string" && token !== "") return { kind: "proof", token };

  // A CAVEAT WORTH KNOWING AT 3AM: the SDK swallows storage-WRITE failures on the refresh path
  // (`updateWithTokensResponse` emits `error_storing_tokens` and returns rather than throwing), so a
  // browser that can read storage but not write it leaves the OLD token in place. The sentence below
  // would then be wrong about the cause — it is the best available guess, not a diagnosis, and the
  // console line beside it is what tells an operator to go and look.
  return {
    kind: "unavailable",
    why:
      'Privy authenticated the player but issued no identity token. The app\'s "Return user data in '
      + 'an identity token" setting is off — it is off by default. See er-demo/api/README.md, '
      + '"What the operator has to do by hand".',
  };
}

/**
 * A proof, having first made sure one exists.
 *
 * THE ORDER OF THE BRANCHES IS THE DESIGN, not a convenience:
 *
 *   1. NO STORED TOKEN -> log in. This is the first-ever press and the main path, and it is reached
 *      after nothing but a microtask, so `window.open` still has the player's activation.
 *   2. A STORED TOKEN -> refresh the session and return the re-minted one. No window, one round trip,
 *      and a token that is seconds old rather than however old the last press left it.
 *   3. THE REFRESH FAILED -> log in, and remember the failure so the next press takes branch 1.
 *   4. THE REFRESH IS SLOW -> log in without waiting for it, and remember NOTHING, because a slow
 *      network says nothing about whether the session is good (`refreshedUser`).
 *   5. THE SESSION HAS NO X ACCOUNT -> log in. Cannot happen while X is the only method we invoke,
 *      and is handled rather than assumed away because the alternative is telling a player they
 *      cancelled a window that never opened (`hasXAccount`).
 *
 * The stored token from branch 1's check is deliberately NOT returned as-is. It is only a signal that
 * a session probably exists; its age is unknown and unknowable here without parsing it, which is the
 * thing `xProof.ts` forbids. Branch 2 replaces it with one whose age is known because we just caused
 * it to be issued.
 */
export function identityTokenViaPrivy(): Promise<PrivyProofOutcome> {
  // ONE AT A TIME, AND THE SECOND CALLER GETS THE FIRST ONE'S ANSWER.
  //
  // Two overlapping runs would share one window — `POPUP_NAME` means `window.open` hands both the
  // SAME window — and then corrupt each other through the SDK's storage: `generateURL` writes
  // `privy:code_verifier` and `privy:state_code`, so the second call overwrites the first's PKCE
  // material, both poll the same window, both read the same single-use code, and whichever loses
  // gets `pkce_state_code_mismatch` — the SDK's phishing alarm, raised by us against ourselves.
  //
  // NOT REACHABLE TODAY: `useXCeremony.ts` guards presses with a ref, and `runLink`'s two calls are
  // sequential. This is here because the comment on `POPUP_NAME` claims the shared name makes a
  // second press safe, and without this it makes a second press share and corrupt one window.
  inFlight ??= identityTokenViaPrivyOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let inFlight: Promise<PrivyProofOutcome> | null = null;

async function identityTokenViaPrivyOnce(): Promise<PrivyProofOutcome> {
  if (typeof window === "undefined") {
    return { kind: "unavailable", why: "there is no window to open an authorisation flow from." };
  }

  const appId = appIdOf(import.meta.env?.VITE_PRIVY_APP_ID);
  if (appId === null) {
    return {
      kind: "unavailable",
      why:
        "VITE_PRIVY_APP_ID was not set when this build was made, so there is no Privy app to "
        + "authenticate against. It is the same value the server checks every token's `aud` against.",
    };
  }

  let privy: Privy;
  try {
    privy = privyClient(appId);
  } catch (error) {
    return { kind: "unavailable", why: reasonOf(error, "the Privy client could not be created") };
  }

  // Storage-only, so this resolves in a microtask and the user activation survives it. Wrapped
  // because a browser with storage disabled (Safari's Lockdown mode, a hardened profile) throws on
  // the access itself rather than returning nothing — and a login is still worth attempting then,
  // even though it is unlikely to be able to store its result.
  let stored: string | null = null;
  try {
    stored = await privy.getIdentityToken();
  } catch {
    stored = null;
  }

  if (stored === null || stored === "" || sessionRefreshFailed) return runOAuth(privy);

  // Re-mints the identity token as a side effect. See "FRESHNESS" in this file's header — it is the
  // reason this call is here rather than a cheaper read.
  const refreshed = await refreshedUser(privy);

  if (refreshed.kind === "rejected") {
    // An expired or incomplete session — an ordinary consequence of time passing, and the remedy is
    // the login below. LATCHED, because it will not get better on its own, and the next press should
    // not spend the wait again before opening a window (`sessionRefreshFailed`).
    //
    // Said at `debug` — invisible to a player, one line for anybody who opens a console. It is here
    // because this branch quietly changes how the rest of the page behaves, and "why does it pop up
    // every single time for this user" is otherwise a question with no evidence attached to it.
    sessionRefreshFailed = true;
    console.debug(`[xlink] ${refreshed.why} — logging in again.`);
    return runOAuth(privy);
  }

  if (refreshed.kind === "unreachable" || refreshed.kind === "slow") {
    // NOT LATCHED, DELIBERATELY — see `refreshRejectedTheSession`. This attempt failed; the session
    // may be perfectly good, and the next press must be allowed to find that out.
    if (refreshed.kind === "unreachable") console.debug(`[xlink] ${refreshed.why} — logging in.`);
    return runOAuth(privy);
  }

  if (!hasXAccount(refreshed.user)) return runOAuth(privy);
  // A refresh that worked proves the credentials do work, whatever an earlier one said.
  sessionRefreshFailed = false;
  return tokenOutcome(privy);
}
