import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
//
// `@solana/web3.js` and `@coral-xyz/anchor` are Node-authored packages that assume `Buffer` and
// `process` exist as globals (borsh (de)serialization, PDA seed handling, etc. all reach for
// `Buffer` directly) — true in Node/Bun, not true in a browser without a polyfill. Every
// Solana+Vite starter template carries some form of this; scoped to just `buffer`/`process`/`crypto`
// rather than the plugin's full default (which also shims `fs`, `path`, and other globals this app
// never touches) to keep the bundle from carrying dead weight.
//
// `crypto`/`stream`/`string_decoder` close the gap flagged in sim/erSim.ts's own "RUNTIME CAVEAT"
// comment (Phase 2's port left this unresolved on purpose, deferring it to whoever needed erSim.ts
// to actually run in a browser — Phase 4, here): `tickHash()` calls `node:crypto`'s
// `createHash("sha256")`, which has no browser built-in. This maps that import to
// `crypto-browserify` (this plugin's stdlib shim for `crypto`) rather than editing erSim.ts itself —
// verified directly this session that `crypto-browserify`'s `createHash("sha256").update(buf).digest()`
// produces byte-identical output to Node's real `node:crypto` for the same input, so the parity
// oracle's hash chain is unaffected by which implementation is actually running underneath it.
//
// `stream`/`string_decoder` are NOT extra scope creep here — they're `crypto-browserify`'s own real
// transitive dependency closure (`create-hash` -> `cipher-base` -> `stream.Transform` +
// `string_decoder.StringDecoder`), traced and confirmed directly against a real browser runtime
// error (`Cannot read properties of undefined (reading 'call')` in `cipher-base`) before adding
// them, not guessed preemptively. Without `stream` specifically aliased to this plugin's shim,
// there's no real npm package literally named `stream` for the bundler to resolve the bare import
// to at all (unlike `string_decoder`, which happens to also exist as a real, already-installed
// userland package — included explicitly anyway so both halves of this closure are resolved the
// same deliberate way, not one by alias and one by resolver accident).
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ['buffer', 'process', 'crypto', 'stream', 'string_decoder'] }),
  ],
  // Two entries. `index.html` is the existing app, untouched; `arena.html` is the v2 page
  // (src/v2/), which shares only chain/ and sim/ with it — by import, never by mutation. Dev needs
  // nothing here (Vite serves any .html in the root), but a build would silently ship only
  // index.html without this.
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        arena: resolve(__dirname, 'arena.html'),
      },
    },
  },
})
