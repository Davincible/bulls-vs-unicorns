// bot-bank — the pool of REAL, deposited money that arena bots play with.
//
// Arena bots used to invent their bank out of thin air (BOT_BANK_MIN..MAX). That money became a
// genuine liability the moment a real player won it, backed by nothing. Now the seeded bot wallets
// (see bot-wallets.ts / seed-bots.ts) hold balances that came from actual on-chain deposits, and
// every bot draws its stake FROM that pool.
//
// The invariant this buys us: the total money bots can ever put at risk is bounded by what was
// really deposited into the vault. A player who wins off a bot is paid from tokens the vault
// actually holds.
//
// Drawing is a pure ledger reallocation (pool account down, bot account up), so value is conserved
// and nothing new is minted.
import { ledger, type Account } from "./ledger.ts";
import { poolPubkeys } from "./bot-wallets.ts";

export type Field = "bull" | "uwu" | "sol";

let poolIds: string[] = [];

/** Adopt the seeded wallets as house accounts. Their deposits are the bots' entire bankroll. */
export function initBotBank(): { wallets: number; bull: number; uwu: number; sol: number } {
  poolIds = poolPubkeys();
  let bull = 0, uwu = 0, sol = 0;
  for (const id of poolIds) {
    const a = ledger.get(id);
    if (!a) continue;
    // house money, not a player liability - these are our own funded wallets
    a.isBot = true;
    if (!a.name || a.name === "You") a.name = "house";
    bull += a.bull; uwu += a.uwu; sol += a.sol;
  }
  return { wallets: poolIds.length, bull, uwu, sol };
}

export function poolAccounts(): Account[] {
  return poolIds.map(id => ledger.get(id)).filter(Boolean) as Account[];
}

/** How much real backing is left for this token. */
export function poolBalance(field: Field): number {
  return poolAccounts().reduce((n, a) => n + (a[field] || 0), 0);
}

// A single bot must never be able to swallow the whole float. Without this the first ~20 bots took
// everything (3000 -> 0 in 16 minutes) and every later bot got a zero bank, which emptied the
// 2-team arenas completely. Capping each draw at a share of what's left makes the float spread
// across the population and degrade smoothly: a thin pool means many small bots, not a few rich
// ones and a dead arena.
const SPREAD = Number(process.env.BOT_BANK_SPREAD || 40);   // ~how many bots the float should cover

/** Take up to `want` of `field` out of the pool, never more than a fair share of what remains.
 *  Returns what was actually granted (may be less, or 0 when truly exhausted). */
export function drawBank(field: Field, want: number): number {
  if (!(want > 0)) return 0;
  const share = poolBalance(field) / Math.max(1, SPREAD);
  const target = Math.min(want, share);      // what we'll try to grant
  if (!(target > 0)) return 0;
  let left = target;
  for (const a of poolAccounts()) {
    if (left <= 0) break;
    const take = Math.min(a[field] || 0, left);
    if (take <= 0) continue;
    a[field] -= take;
    left -= take;
  }
  return target - left;                      // granted = target minus whatever we couldn't source
}

/** Give money back to the pool (a bot being pruned, or handing back an unused bank). */
export function returnBank(field: Field, amount: number): void {
  if (!(amount > 0)) return;
  const a = poolAccounts()[0];
  if (a) a[field] += amount;
}

/** True once at least one funded wallet exists — otherwise bots have to fall back to fake banks. */
export function botBankReady(): boolean {
  return poolIds.length > 0 && (poolBalance("bull") + poolBalance("uwu") + poolBalance("sol")) > 0;
}
