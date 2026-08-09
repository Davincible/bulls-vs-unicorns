import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
//
// `@solana/web3.js` and `@coral-xyz/anchor` are Node-authored packages that assume `Buffer` and
// `process` exist as globals (borsh (de)serialization, PDA seed handling, etc. all reach for
// `Buffer` directly) — true in Node/Bun, not true in a browser without a polyfill. Every
// Solana+Vite starter template carries some form of this; scoped to just `buffer`/`process` rather
// than the plugin's full default (which also shims `fs`, `path`, and other globals this app never
// touches) to keep the bundle from carrying dead weight.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ['buffer', 'process'] }),
  ],
})
