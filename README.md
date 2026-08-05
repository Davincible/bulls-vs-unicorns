# Bulls ⚔ Unicorns — The Arena (production)

Real-money PvP arena on Solana. Two communities (Ansem **BULL** vs **UWU**) deploy their
tokens into rounds; fighters clash; you raid the enemy's coin into your bag. Off-chain
engine runs the battles with provably-fair (commit-reveal) randomness; an on-chain
Anchor vault custodies real funds. This is the productionization of `../bulls-vs-unicorns/arena.html`.

> ⚠️ Real-money betting. Regulatory/licensing exposure (especially with house bots).
> Build & test on **devnet** first; mainnet only after security review + legal sign-off.
> The engine/admin keys are held by **you**, never committed, never handled by the build.

## Architecture (decided)

```
 Player wallet (Phantom)
      │ 1. deposit BULL/UWU  ──────────────►  ┌─────────────────────────┐
      │ 4. withdraw (signed vs balance) ◄────  │  Anchor VAULT program   │  on-chain (Solana)
      │                                         │  · pooled SPL vaults    │
      │                                         │  · house fee account    │
      │                                         │  · settleRound (signer) │
      │                                         └───────────▲─────────────┘
      │ 2. enter round (ws)                                 │ 3. post net settlement (batched)
      ▼                                                     │
 ┌─────────────────┐   round loop + commit-reveal RNG   ┌───┴──────────────┐
 │  Web (Next.js)  │◄──────── websocket state ──────────│  Engine (Node)   │  off-chain
 │  · wallet adapt │                                     │  · battle sim    │
 │  · arena canvas │                                     │  · Postgres ledgr│
 │  · dashboards   │                                     │  · settlement    │
 └─────────────────┘                                     └──────────────────┘
```

**Money model (cheap by design):** the vault is **pooled** (a few on-chain accounts total,
not one per player). Per-player balances live in **Postgres**; the engine posts **net**
deposit/withdraw/fee deltas on-chain via `settleRound`, signed by the settlement authority.
Withdrawals always verify against the on-chain-committed balance root — the engine can
never move funds to itself.

**Fairness (commit-reveal):** before each lobby closes the engine publishes `sha256(seed)`.
After the round it reveals `seed`. Anyone recomputes `battle = f(seed, entries)` and checks
it matches. Seed committed *before* deposits close ⇒ no seed-grinding.

**Economy (ported from the tuned prototype):**
- Deploy fee **0.2%** of each deposit → house fee account.
- Damage = geometric mean of both fighters' sizes, capped 25%/hit ⇒ size-neutral, low churn.
- Persistent NPC accounts (hybrid: seed early liquidity, disclosed, throttle down as real players join).
- Modes: **Normal** (raids compound in-ring) and **Extraction** (raids bank to wallet).

## Cost (devnet = $0)
- All development/testing on **devnet**: free (airdropped SOL).
- Mainnet program deploy: **~2 SOL** one-time (pooled design keeps it small; recoverable if closed).
- Per-tx fees: ~$0.0002. Commit-reveal RNG: no oracle cost.
- Budget ~5–10 SOL for mainnet launch + iteration.

## Layout
```
programs/vault/   Anchor program (Rust) — pooled custody + settleRound
engine/           Node + TypeScript — round loop, commit-reveal, battle sim, settlement, ws
web/              Next.js — wallet adapter + arena UI (ported from prototype)
shared/           shared types (rooms, battle state, settlement)
```

## Dev setup (devnet)
1. Toolchain: Rust, Solana CLI, Anchor (Linux/WSL recommended for Anchor builds), Node ≥ 18.
2. `solana config set --url devnet && solana airdrop 5`
3. `cd programs/vault && anchor build && anchor deploy` (devnet)
4. Create devnet test mints for BULL/UWU; set them in `engine/.env`.
5. `cd engine && npm i && npm run dev`
6. `cd web && npm i && npm run dev`

## Go-live checklist (mainnet)
- [ ] Security review / audit of the vault program (it holds real funds)
- [ ] Settlement authority = **multisig** (Squads), not a single hot key
- [ ] Legal: entity, jurisdiction, geo-block, terms, age-gate; decide KYC
- [ ] Confirm BULL/UWU have routable mainnet liquidity (Jupiter) for conversions
- [ ] Load-test engine + settlement; monitoring/alerting
- [ ] Bot disclosure in UI; throttle-down plan
- [ ] Fund the mainnet deploy (~2 SOL) + house liquidity

## Mainnet tokens
- BULL (Ansem): `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`
- UWU (Unicorn): `UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump`
- (Devnet uses freshly-minted test tokens.)
