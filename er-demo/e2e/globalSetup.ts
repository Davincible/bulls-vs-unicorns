// SERVE THE THING THAT SHIPS, not a dev server.
//
// `vite preview` serves `dist/` — the same static bundle Fly serves at bullsvsunicorns.fun, built by
// the same `npm run build` that produced it. A dev server would be a different artifact: unminified,
// unbundled, module-per-file, with HMR injected and `import.meta.env` resolved differently. Three of
// the six defects this suite is written against are about what a surface PRINTS, and a build step is
// exactly where a printed string can change; testing the pre-build source would leave that step
// unwatched.
//
// `test:e2e` runs the build first, so `dist/` is never stale. This file refuses to start without it
// rather than silently serving the last one somebody happened to leave behind — a suite that passes
// against a build from three commits ago is worse than one that fails.
//
// `strictPort` for the same reason: if something else is on 5199, that is a fact worth failing on,
// not a reason to quietly test whatever is answering.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { preview, type PreviewServer } from "vite";
import { E2E_PORT } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "..");

let server: PreviewServer | null = null;

export async function setup(): Promise<void> {
  const bundle = resolve(ROOT, "dist/index.html");
  if (!existsSync(bundle)) {
    throw new Error(
      `e2e: ${bundle} does not exist — run \`npm run build\` first (\`npm run test:e2e\` does it for you).`,
    );
  }
  server = await preview({
    root: ROOT,
    preview: { port: E2E_PORT, strictPort: true, host: "127.0.0.1" },
    // The bundle is what is under test; a preview server logging every asset it serves buries the
    // one line that matters when something fails.
    logLevel: "warn",
  });
}

export async function teardown(): Promise<void> {
  await server?.close();
  server = null;
}
