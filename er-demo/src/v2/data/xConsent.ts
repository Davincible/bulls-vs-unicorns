// THE WORDS SAID TO A PLAYER ABOUT LINKING THEIR X ACCOUNT.
//
// Copy lives in the data layer here, as `abandonText()` does, because these particular sentences are
// claims about what the system does and they have to be reviewable next to the code that makes them
// true. A string inlined in a component is a claim nobody diffs.
//
// ================================================================================================
// THE SENTENCE THAT MATTERS MOST IS `DEANONYMISATION`, AND IT IS DESIGNED TO REDUCE THE LINK RATE.
//
// Linking does not expose a leaderboard row. It permanently deanonymises a WALLET. Every token it
// has ever held, every transfer it has made, every other protocol it has touched — past and future —
// becomes public under a real name, on a ledger that does not forget. Once a scraper has seen the
// pairing, deleting our row changes nothing about what it knows.
//
// A player cannot consent to that unless they are told it in one plain sentence, before the redirect,
// in language that does not soften it. `TWITTER-CONNECT.md` §6.1 is explicit that this will cost us
// links and that **that is the correct outcome**. Anyone editing these strings to improve conversion
// is editing the wrong thing: the conversion rate is not the number this copy is optimising.
// ================================================================================================
//
// THE NUMBERS IN HERE ARE LOAD-BEARING AND MUST TRACK THE CODE. `REVOCATION_COPY` states how long a
// face survives an unlink, and if `useLinks.ts#REFRESH_MS` or the avatar `Cache-Control` changes,
// these sentences become false. They are derived from those constants below rather than typed out,
// so that cannot happen quietly.

/** From `useLinks.ts#REFRESH_MS` — how often a browser re-reads the link map. */
const REFRESH_SECONDS = 60;
/** From the avatar proxy's `Cache-Control: max-age=86400`. Twenty-four hours rather than a year, and
 *  that is deliberately paid: a long immutable cache would make a revoked picture effectively
 *  permanent. `TWITTER-CONNECT.md` §7.2. */
const AVATAR_CACHE_HOURS = 24;

/**
 * BEFORE THE REDIRECT. The consent screen's whole argument, in the order a person needs it.
 *
 * `TWITTER-CONNECT.md` §6.1 supplies the middle sentence almost verbatim and it should stay that way.
 * It is not softened, not bulleted into invisibility, and not placed below a button.
 */
export const CONSENT_COPY = {
  heading: "Linking makes this wallet public under your name",
  /** §6.1's sentence. If you change nothing else in this file, do not change this. */
  deanonymisation:
    "Anyone will be able to see that this wallet belongs to your X account. This wallet's entire "
    + "on-chain history — everything it has ever held or sent — becomes public under your name. "
    + "This cannot be undone by disconnecting.",
  /** Said second, because it is the honest limit of what a delete can do for you. */
  irreversible:
    "Unlinking removes you from this site. It cannot remove what anyone has already seen or copied.",
  /** What actually happens, so the two prompts are not a surprise. Wallet signatures are how players
   *  get trained to sign anything; a prompt with no explanation is the training. */
  whatHappens:
    "Two steps: authorise X, then sign a message proving this wallet is yours. The signature is not "
    + "a transaction. It moves no funds and costs nothing.",
  proceed: "Link my X account",
  cancel: "Not now",
} as const;

/** The wallet panel, unlinked. ONE line, in one place, and no per-row nagging anywhere else. */
export const UNLINKED_COPY = {
  action: "Connect X",
  /** Why a player might want this at all — and `SOCIAL.md` §3.4's honest reason, which is that
   *  `nameFor()` has 3,880 possible pseudonyms and therefore collides, so a handle is the only name
   *  on this page that is actually unique. */
  invitation:
    "Your X name and picture become your fighter's face, and your handle replaces the pseudonym this "
    + "page picked for you.",
  /** Said quietly and always, because it is the thing that makes the unlinked state a choice rather
   *  than a gap. */
  optional: "Linking is optional and changes nothing about how you play.",
} as const;

/** The wallet panel, linked. */
export const LINKED_COPY = {
  unlink: "Unlink",
  /** THE NATURAL WRONG ASSUMPTION, corrected before it costs anyone anything. Disconnecting a wallet
   *  looks like leaving; it is not, and the consequence — your face keeps appearing on the board — is
   *  exactly the kind of surprise this page refuses to hand out. */
  disconnectIsNotUnlink:
    "Disconnecting your wallet does not unlink your X account. Your face keeps appearing until you "
    + "unlink.",
} as const;

/**
 * What unlinking actually does, with the real numbers.
 *
 * `TWITTER-CONNECT.md` §6.2 says "Leaderboard effect: immediate". **That is not achievable from a
 * browser and this copy does not claim it.** The API stops serving the record immediately, but every
 * open tab is holding a self-certifying attestation and only re-reads the map every
 * `REFRESH_SECONDS`; the picture then survives in the CDN for up to `AVATAR_CACHE_HOURS`. Stating
 * both numbers is the version of this a player can actually rely on, and staleness stated is
 * staleness handled.
 */
export const REVOCATION_COPY = {
  heading: "Unlink your X account",
  effect:
    `You disappear from the leaderboard and the board within about ${REFRESH_SECONDS} seconds for `
    + `anyone with the page open. A cached copy of your picture may persist for up to `
    + `${AVATAR_CACHE_HOURS} hours.`,
  /** The same limit as the consent screen's, said again at the moment it becomes relevant. */
  irreversible:
    "This does not undo the link between this wallet and your name for anyone who already recorded it.",
  confirm: "Unlink",
  cancel: "Keep it linked",
} as const;

/**
 * THE DISCLOSURE SENTENCE — who verified this face, in one line, wherever an identity is shown at
 * readable size.
 *
 * `SOCIAL.md` §2.6 settled the shape of this and it is worth restating why it is a sentence rather
 * than a badge: `SPEC.md`'s `SIM` marker exists for money-shaped figures with nothing behind them,
 * and `GAPS.md` was right that a marker cannot go on a face. But an identity is not a figure — the
 * honest question about an attribution is not "is it chain-derived" but "who verified it".
 */
export const PROVENANCE_NOTE =
  "A face means this wallet proved it controls that X account, by signing for it. The proof is held "
  + "by this site, not by the chain — the chain knows only wallets.";

/**
 * THE ANSWER WHILE THE CEREMONY DOES NOT EXIST YET. Provisional, and flagged as such — it is a
 * placeholder written by the wallet-panel work so the panel had no string of its own, not a
 * considered sentence, and it belongs to whoever owns the rest of this file.
 *
 * `?links=mock` and `?links=api` render the panel's `Connect X` and `Unlink` controls so that
 * `SOCIAL.md` §4.0's three states can be reviewed on a real page. `TWITTER-CONNECT.md` §10's Stage 3
 * — the OAuth start, callback, challenge and link endpoints — is not built, so neither control can
 * do anything, and pressing one has to say so.
 *
 * IT DELIBERATELY DOES NOT REUSE `FAILURE_COPY.unavailable`. That sentence ends "Try again in a
 * minute", which is true of a transient outage and false of a feature that does not exist. A page
 * whose standing rule is that nothing claims more than it can back does not get an exception for one
 * sentence in a panel nobody has shipped.
 *
 * There is no handle-entry offer here for the same reason there is none anywhere else in this file.
 */
const NOT_BUILT_REASON =
  "X linking is not built yet — this control is here so the linked and unlinked states can be "
  + "reviewed. Nothing was sent and nothing was changed.";

/**
 * WHAT WE SAY WHEN THE CEREMONY FAILS — and the list is short on purpose.
 *
 * THERE IS NO ENTRY HERE FOR "ENTER YOUR HANDLE INSTEAD". The old build's fallback path
 * (`web/index.html:2900`) answered every one of these failures with `prompt("Your X handle")` and
 * wrote the answer through the same message as a proven one, which is how typing `blknoiz06` put
 * Ansem's real name and photograph on a fighter. If the ceremony fails there is no identity, the
 * button says so, and the only offer is to try again.
 */
export const FAILURE_COPY = {
  notBuilt: NOT_BUILT_REASON,
  cancelled: "You cancelled before X confirmed. Nothing was linked.",
  /** The one a player is most likely to hit, and the one most likely to be misread as our bug. */
  walletRefused: "Your wallet declined to sign, so nothing was linked. You can try again.",
  expired: "That took too long and the request expired. Start again and it will work.",
  alreadyLinked:
    "That X account is already linked to a different wallet. Unlink it there first — one X account "
    + "belongs to one wallet.",
  /** THERE IS DELIBERATELY NO ENTRY HERE FOR "THIS WALLET IS ONE OF THE ARENA'S OWN", and its absence
   *  is a rule rather than a gap somebody should helpfully fill.
   *
   *  One existed — "This wallet is one of the arena's own and cannot carry a face." — and nothing ever
   *  rendered it. It could not be rendered now even if a surface wanted it, because a refusal that
   *  names its reason is a MEMBERSHIP ORACLE: anyone could walk a candidate wallet up to the link
   *  endpoint and read the arena's roster straight off the error text, one key at a time. That is
   *  exactly what declining to publish the list was for, handed back through a different door, and
   *  handed back to the one party motivated to go looking.
   *
   *  So if a surface ever does need to refuse for this reason, the sentence it shows MUST be
   *  indistinguishable from the generic one below — same words, same timing, no extra hint. Saying
   *  less is the entire point of `unavailable`, and this is the case it was already right for. */
  /** Deliberately vague, because the specific reasons are all ours and none is actionable. */
  unavailable: "X linking is unavailable right now. Nothing was changed. Try again in a minute.",
  retry: "Try again",
} as const;
