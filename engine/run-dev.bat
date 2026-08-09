@echo off
REM Local DEVNET engine - the sandbox where changes get proven before touching mainnet.
REM Fake bot banks (test chains only), public-devnet mints, ledger in a throwaway dir.
REM   engine\run-dev.bat            starts on ws://localhost:8091
REM   node observe.mjs ws://localhost:8091 5     watch rounds settle
set PORT=8091
REM Set SOLANA_RPC yourself before running this. A live Helius key used to sit on the next
REM line, in a public repository, shared with the mainnet script — it has been rotated, and no
REM default is provided so a replacement has nowhere to be pasted back into.
if "%SOLANA_RPC%"=="" ( echo SOLANA_RPC is not set - export your own devnet RPC endpoint & exit /b 1 )
set CHAIN_CONFIG=devnet-public.json
set LEDGER_DIR=%TEMP%\bulls-dev-ledger
set BOT_FAKE_BANK=1
set ENABLED_ARENAS=us-extraction,au-normal,au-extraction
if not exist "%LEDGER_DIR%" mkdir "%LEDGER_DIR%"
cd /d "%~dp0"
npx tsx src/server.ts
