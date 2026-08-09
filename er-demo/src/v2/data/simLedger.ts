// THE SIMULATED LEDGER — every money-shaped number on this page that the chain has no concept of.
//
// The ER program custodies NOTHING. There are no token accounts, no deposits, no withdrawals, no
// house treasury, no referral programme; `enter()` moves a u64 inside one account and `extract()`
// moves it back. The original game had all of those, so v2 models them here, in localStorage, and
// every surface that shows one of these figures carries the `SIM` marker. That marker is the whole
// deal: a money-shaped number with nothing behind it and no label is the one thing this page must
// never ship.
//
// PURE ON PURPOSE. Every mutation below is a function from ledger to ledger — no React, no storage
// access — so `simLedger.test.ts` can exercise the arithmetic directly and `useSimLedger.ts` only has
// to worry about persistence. `load()` never throws: a hand-edited or half-written value under the
// storage key must degrade to a fresh ledger, not white-screen the page.
//
// UNITS. Everything here is in DOLLARS (plain `number`), not the chain's u64 units — it is play money
// modelling a fiat-denominated product, and `contract.ts`'s `unitsToUsd()` is the one bridge between
// the two. Floating point is correct for a simulation of dollars; it would not be for a real balance,
// and no real balance passes through this file.

import {
  CONVERT_BPS,
  REFERRAL_SHARE_PCT,
  type FeeRate,
  type SimBalances,
  type SimLedger,
  type TokenKey,
} from "../contract.ts";

/** Versioned: the shape of `SimLedger` is allowed to change, and when it does, a stored ledger from
 *  the previous shape must be ignored rather than half-read. Bump the suffix, don't migrate — this is
 *  play money by construction. */
export const SIM_LEDGER_KEY = "v2.sim.ledger.1";

const BPS_DIVISOR = 10_000;

/** Starting play money, so the dashboard and the deploy panel have something to show on a first
 *  visit. NOT modelled as a deposit — `deposited` stays 0, because nobody deposited anything; it is a
 *  stocked demo account and the `SIM` marker says so. */
export const INITIAL_LEDGER: SimLedger = {
  balances: { ansem: 250, uwu: 250, sol: 40 },
  treasury: { ansem: 0, uwu: 0, sol: 0 },
  deposited: 0,
  withdrawn: 0,
  referralEarned: 0,
  referralCount: 0,
};

/** A finite, non-negative amount. Everything else — NaN from an empty input box, Infinity, a negative
 *  "withdrawal" that would be a deposit — is rejected at the door, so no reducer below has to defend
 *  itself and no stored ledger can end up holding a NaN that poisons every later sum. */
function isValidAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function balancesFrom(value: unknown, fallback: SimBalances): SimBalances {
  const o = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    ansem: num(o.ansem, fallback.ansem),
    uwu: num(o.uwu, fallback.uwu),
    sol: num(o.sol, fallback.sol),
  };
}

/** Rebuilds a valid ledger out of whatever was actually stored — a truncated write, an older shape,
 *  someone's experiment in devtools. Field by field, never trusting the object's own claim to be a
 *  `SimLedger`. */
export function sanitize(raw: unknown): SimLedger {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    balances: balancesFrom(o.balances, INITIAL_LEDGER.balances),
    treasury: balancesFrom(o.treasury, INITIAL_LEDGER.treasury),
    deposited: num(o.deposited, 0),
    withdrawn: num(o.withdrawn, 0),
    referralEarned: num(o.referralEarned, 0),
    referralCount: num(o.referralCount, 0),
  };
}

export function load(): SimLedger {
  if (typeof localStorage === "undefined") return INITIAL_LEDGER;
  const raw = localStorage.getItem(SIM_LEDGER_KEY);
  if (!raw) return INITIAL_LEDGER;
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    // Malformed JSON is not an error condition worth surfacing — it is play money, and a fresh
    // ledger is a complete recovery.
    return INITIAL_LEDGER;
  }
}

export function save(ledger: SimLedger): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SIM_LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Quota exceeded, or storage disabled (private browsing in some engines). The page keeps working
    // from memory; only persistence across a reload is lost, which is not worth interrupting anyone.
  }
}

function withBalance(balances: SimBalances, token: TokenKey, next: number): SimBalances {
  return { ...balances, [token]: next };
}

export function deposit(ledger: SimLedger, token: TokenKey, amountUsd: number): SimLedger {
  if (!isValidAmount(amountUsd)) return ledger;
  return {
    ...ledger,
    balances: withBalance(ledger.balances, token, ledger.balances[token] + amountUsd),
    deposited: ledger.deposited + amountUsd,
  };
}

/** Withdrawing more than the balance takes the balance to zero and books only what was actually
 *  there — the alternative (a negative balance, or a silent no-op) both describe a state the product
 *  being simulated could never reach. */
export function withdraw(ledger: SimLedger, token: TokenKey, amountUsd: number): SimLedger {
  if (!isValidAmount(amountUsd)) return ledger;
  const taken = Math.min(amountUsd, ledger.balances[token]);
  if (taken <= 0) return ledger;
  return {
    ...ledger,
    balances: withBalance(ledger.balances, token, ledger.balances[token] - taken),
    withdrawn: ledger.withdrawn + taken,
  };
}

/** 1:1 minus `CONVERT_BPS` (0.3%), mirroring the original's convert fee. The fee is house revenue, so
 *  it lands in the treasury in the DESTINATION token — that is where the value actually is. */
export function convert(ledger: SimLedger, from: TokenKey, to: TokenKey, amountUsd: number): SimLedger {
  if (!isValidAmount(amountUsd) || from === to) return ledger;
  const taken = Math.min(amountUsd, ledger.balances[from]);
  if (taken <= 0) return ledger;
  const fee = (taken * CONVERT_BPS) / BPS_DIVISOR;
  const balances = withBalance(
    withBalance(ledger.balances, from, ledger.balances[from] - taken),
    to,
    ledger.balances[to] + (taken - fee),
  );
  return {
    ...ledger,
    balances,
    treasury: { ...ledger.treasury, [to]: ledger.treasury[to] + fee },
  };
}

/** The original's "+ $100 & $100" test-money button. */
export function topUp(ledger: SimLedger): SimLedger {
  return {
    ...ledger,
    balances: { ...ledger.balances, ansem: ledger.balances.ansem + 100, uwu: ledger.balances.uwu + 100 },
  };
}

/**
 * Books a CONFIRMED deploy against the simulated custody layer: the stake leaves the player's
 * simulated balance and the arena's fee accrues to the house.
 *
 * THE RATE IS A PARAMETER, AND THAT IS THE POINT. This module is play money — but it is play money
 * booked off a REAL event: the provider calls this from `useOnEntered` when a chain `enter()`
 * confirms, and the chain charged whatever `Arena.fee_bps` said at that instant. Accruing at a
 * build-time constant instead would put a house take in this ledger that no player was ever charged,
 * and the referrals screen prints the accrued balance directly beneath the live rate — so the two
 * would be visibly different numbers describing the same deploy, one paragraph apart. That is the
 * defect this whole path exists to close, and the ledger is not exempt from it just because the
 * dollars are invented. The caller passes the same `FeeRate` the page is displaying.
 *
 * IT NEVER GATES THE REAL ACTION. `enter()` on chain does not know this ledger exists, so refusing a
 * deploy because simulated play money ran out would be a fiction blocking a fact. The balance floors
 * at zero and the deploy still happened.
 *
 * REFERRALS — A MODEL, NOT AN OBSERVATION. No client can see someone else using your link, and the
 * chain has no referral concept at all. So `referralEarned` demonstrates the original's rate
 * (`REFERRAL_SHARE_PCT` of the house fee) against the only play this browser can actually see —
 * your own — and only once the referral wiring is active in the sim (`referralCount > 0`, set by
 * arriving on a `?ref=` link). It is a rate made visible, never a claim that anyone was referred;
 * the `SIM` marker on the referrals screen is doing real work.
 */
export function recordDeploy(
  ledger: SimLedger,
  token: TokenKey,
  amountUsd: number,
  arenaFee: FeeRate,
): SimLedger {
  if (!isValidAmount(amountUsd)) return ledger;
  const fee = (amountUsd * arenaFee.bps) / BPS_DIVISOR;
  const referral = ledger.referralCount > 0 ? (fee * REFERRAL_SHARE_PCT) / 100 : 0;
  return {
    ...ledger,
    balances: withBalance(ledger.balances, token, Math.max(0, ledger.balances[token] - amountUsd)),
    treasury: { ...ledger.treasury, [token]: ledger.treasury[token] + fee - referral },
    referralEarned: ledger.referralEarned + referral,
  };
}

/** Records that this browser arrived through someone's `?ref=` link — which is the only referral
 *  fact any client can establish (see `recordDeploy`). Idempotent: a reload is not a second
 *  referral. */
export function registerReferral(ledger: SimLedger, seen: boolean): SimLedger {
  if (!seen || ledger.referralCount > 0) return ledger;
  return { ...ledger, referralCount: 1 };
}

export function reset(): SimLedger {
  return INITIAL_LEDGER;
}
