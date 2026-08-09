// WHERE THE KEEPER'S SECRET KEYS COME FROM — a file on a laptop, an env var in a container, and one
// rule about which wins.
//
// This process holds two sets of real secret keys: the arena AUTHORITY (`open_round` and
// `delegate_round` are both `has_one = authority`, so this key is the arena) and the six house-fighter
// wallets. Locally they live in `.devnet/`, which is gitignored, mode 0600, and never leaves the
// machine. That does not survive containerisation: a key in the image is a key in every layer, in
// every registry copy of that image, and in the build cache of whoever last ran `fly deploy`. Baking
// one in is not a shortcut with a small cost, it is a key you can no longer say where copies of.
//
// So each secret has TWO SOURCES and a fixed precedence:
//
//     env var  ->  wins, always. Production: `fly secrets set …`, injected at runtime, absent from
//                  the image and absent from the repo.
//     file     ->  the fallback. Local development, unchanged: `bun run dev` and
//                  `bun run scripts/keeper/keeper.ts` behave exactly as they did.
//
// ENV WINS RATHER THAN FILE, and the direction matters. The container has no `.devnet/` at all, so on
// Fly the question never arises — but a developer who exports a var to test the production path and
// still has the file on disk must get the var, or they are testing the wrong thing and will say the
// production path works when they have never run it.
//
// WHICH SOURCE WAS USED IS LOGGED, EVERY BOOT. "The keys loaded" is not the interesting fact; "the
// keys loaded FROM WHERE" is, because the two sources can hold different keys and the symptom of
// picking the wrong one is an arena whose authority is somebody else — a failure that costs a boot to
// diagnose if the log says which key file it read, and an afternoon if it does not.
//
// THE MATERIAL ITSELF IS NEVER LOGGED, and that extends further than the obvious. Nothing here ever
// prints the secret, and — less obvious, which is why it is written down — nothing here ever prints a
// JSON PARSER'S message either. `JSON.parse` failures quote the input around the offending character,
// so relaying one for a malformed key would put a fragment of a secret key into `fly logs`, which is
// not a secret store. The errors below say what shape was expected and where the value came from, and
// stop there.

import { readFileSync } from "node:fs";

/** Which of the two sources a secret actually came from. */
export type SecretSource = "env" | "file";

export interface SecretText {
  /** The raw text, exactly as the env var or the file held it. Never logged. */
  text: string;
  source: SecretSource;
  /** The env var name or the file path — safe to log, and the thing an operator needs to see. */
  where: string;
}

/**
 * Read a secret's TEXT from the environment, falling back to a file. `null` when neither exists.
 *
 * Null rather than a throw, because the two callers want different things from "neither": the
 * operator key is required and its absence is a boot failure, while the house-wallet file is created
 * on first boot and its absence is the normal first run. A shared loader that decided that for them
 * would be deciding a policy it cannot see.
 *
 * Only ENOENT falls through to "no file". A file that exists and cannot be read — wrong owner, wrong
 * mode, a directory where a file was expected — is a different fact from a file that is not there,
 * and silently treating it as absent is how a keeper generates a fresh set of house wallets beside a
 * perfectly good one it could not open.
 */
export function readSecretText(envName: string, filePath: string): SecretText | null {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { text: fromEnv, source: "env", where: envName };
  }
  try {
    return { text: readFileSync(filePath, "utf8"), source: "file", where: filePath };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new Error(
      `${filePath} exists but could not be read (${(e as NodeJS.ErrnoException)?.code ?? "unknown error"}). ` +
      `Refusing to treat an unreadable key file as a missing one — set ${envName} instead, or fix the file's ` +
      `ownership and mode (it should be 0600 and owned by you).`,
    );
  }
}

/**
 * Parse a secret's text as JSON, saying where it came from and NOT what it contained.
 *
 * See this file's header on why the parser's own message is dropped: it quotes the input around the
 * failure, and the input is a secret key.
 */
export function parseSecretJson(secret: SecretText, expected: string): unknown {
  try {
    return JSON.parse(secret.text);
  } catch {
    throw new Error(
      `${secret.where} (${secret.source === "env" ? "environment variable" : "file"}) is not valid JSON. ` +
      `Expected ${expected}. The parser's message is deliberately not repeated here, because it would ` +
      `quote the surrounding characters of a secret key into the log.`,
    );
  }
}

/** A JSON array of 64 whole bytes, which is the on-disk shape of every keypair in `.devnet/` and
 *  therefore the shape a secret carrying one must have too — so that `fly secrets set
 *  KEEPER_OPERATOR_KEY="$(cat .devnet/fork-payer.json)"` is the whole migration. */
export function asSecretKeyBytes(value: unknown, secret: SecretText): Uint8Array {
  const ok = Array.isArray(value)
    && value.length === 64
    && value.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255);
  if (!ok) {
    // The LENGTH is reported and the CONTENT is not. A wrong length is by far the most common way to
    // get this wrong (a base58 string, a `{"secretKey": …}` wrapper, a 32-byte seed) and naming it
    // turns the fix into one line; the bytes themselves would be the key.
    throw new Error(
      `${secret.where} (${secret.source === "env" ? "environment variable" : "file"}) is not a secret key. ` +
      `Expected a JSON array of 64 whole numbers 0-255, the same shape as the keypair files in .devnet/; ` +
      `got ${Array.isArray(value) ? `an array of ${value.length}` : typeof value}.`,
    );
  }
  return Uint8Array.from(value as number[]);
}
