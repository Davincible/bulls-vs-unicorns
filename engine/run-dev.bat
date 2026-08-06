@echo off
REM Local DEVNET engine - the sandbox where changes get proven before touching mainnet.
REM Fake bot banks (test chains only), public-devnet mints, ledger in a throwaway dir.
REM   engine\run-dev.bat            starts on ws://localhost:8091
REM   node observe.mjs ws://localhost:8091 5     watch rounds settle
set PORT=8091
set SOLANA_RPC=https://devnet.helius-rpc.com/?api-key=0d960ade-310e-41e1-842f-073257b3978d
set CHAIN_CONFIG=devnet-public.json
set LEDGER_DIR=%TEMP%\bulls-dev-ledger
set BOT_FAKE_BANK=1
set ENABLED_ARENAS=us-extraction,au-normal,au-extraction
if not exist "%LEDGER_DIR%" mkdir "%LEDGER_DIR%"
cd /d "%~dp0"
npx tsx src/server.ts
