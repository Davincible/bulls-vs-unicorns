# Mainnet runbook (prepared ahead — do NOT run yet)

## Real token mints (verified from project records)
- BULL (Ansem): `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`
- UWU (Unicorn): `UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump`
- Template: `mainnet.json.example` — copy to `engine/devnet.json` shape at cutover
  (verify each mint's decimals on-chain first; engine assumes 6).

## Custody — hard requirement before real money
The engine-held vault keypair is fine for test nets only. Mainnet MUST use the Anchor
program (`programs/vault/src/lib.rs`, already written): pooled vault PDAs, on-chain
0.2% fee skim, withdrawals gated by the settlement authority. Build needs
`sudo apt install -y build-essential` in WSL, then anchor-cli; deploy ≈ 2–5 SOL one-time.

## No faucet on mainnet — differences from the test build
- `fundMe`/`faucet` are now HARD-GATED to test chains (engine derives `IS_TEST_CHAIN` from the
  RPC url; `DISABLE_FAUCET=1` forces off). This was a real solvency hole: fundMe credited SOL
  units straight into the ledger with no on-chain deposit behind them, so on mainnet anyone
  could have withdrawn real SOL against invented balance. Verified: pointing the engine at a
  mainnet RPC logs "faucets DISABLED" and refuses both messages.
- Deposits are users' real tokens; keep verifyDeposit sig-replay protection as is.
- Ledger (`engine/data/ledger.json`) must live on a persistent volume; take the
  solvency endpoint (explorer :8140) public — it is the trust story.
- House bots deposit like any user (see kickoff economics in DEVLIST).

## Cheap launch path (no 2-5 SOL needed)
The Anchor deploy cost is rent on the program binary — it is NOT required on day one:
1. **Phase 0 (≈ $0): launch custodial.** The engine-held vault keypair custodies deposits,
   exactly like the current build. Trust is carried by the PUBLIC solvency page (explorer
   `/api/solvency`: on-chain vault holdings vs ledger liabilities, checkable by anyone) plus
   the provably-fair verifier. Total chain cost: ~0.02 SOL of gas + ATA rent.
2. **Phase 1 (~0.01 SOL): move the vault key into a Squads multisig** so no single key can
   drain it. Still no program deploy.
3. **Phase 2: deploy the Anchor vault out of revenue.** At the simulated ~$60/day fee flow,
   the ~2-5 SOL rent is covered by the first days of fees. Build small (opt-level="z",
   strip) — a lean vault can land ~1-1.5 SOL.

## Cutover checklist
1. Anchor vault built + deployed, settlement authority = engine key, admin = cold key.
2. Engine env: `SOLANA_RPC=<helius mainnet url>`, cluster=mainnet, faucet gated off.
3. Fund house bot wallets (~$250 total, see economics) + ~0.1 SOL gas each.
4. Explorer pointed at mainnet RPC; solvency green before opening deposits.
5. Small canary: one $2 deposit → play → withdraw, verified on Solscan, before announce.
