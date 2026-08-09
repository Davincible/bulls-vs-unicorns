// THE TWO ENDPOINTS THIS PROCESS TALKS TO, AND THE GUARD THAT SURVIVES BEING CONFIGURED.
//
// WHY THEY ARE CONFIGURABLE AT ALL. `api.devnet.solana.com` is a shared public endpoint with a
// per-IP rate limit, and this keeper reads the arena and the current round once a second, forever.
// One browser polling beside one sampler was already enough to draw 429s on a laptop; a deployment
// where every visitor's page reads the chain from the same egress IP as the keeper will hit them
// immediately, and a rate-limited keeper is not a degraded keeper — a failed read is a failed pass,
// six of those in a row publishes `stalledSince`, and the page stops promising rounds. So a paid
// devnet endpoint (Helius, QuickNode, Triton) has to be droppable in with no code change.
//
// WHY THAT IS DANGEROUS, AND WHAT IS DONE ABOUT IT. `src/chain/constants.ts` runs `assertDevnetUrl`
// over two hardcoded literals at module load, so today a mainnet URL cannot reach a `Connection`
// without somebody editing a checked-in file and getting it past review. An env var is the obvious
// way to undo that: a value nobody reviews, set on a host nobody reads, that reaches exactly the same
// constructor. Env indirection must not become the hole in the mainnet guard.
//
// So the guard runs HERE, on whatever the environment supplied, at module load — which is before any
// connection is constructed, because `chainClient.ts` cannot build one without importing this file
// first. A mainnet URL in a Fly secret therefore kills the process at boot with `MainnetBlocked` and
// a redacted echo of the offending URL, rather than connecting. That is the same failure the
// hardcoded literals get, arriving through the new door.
//
// The guard fails CLOSED (see `src/devnet-guard.ts`): an allowlist of positively-identified devnet
// shapes, not a denylist of known-bad ones. A consequence worth stating, because it will look like a
// bug the first time somebody meets it: a bare API-key endpoint with no cluster in the hostname —
// `https://rpc.example.com/?api-key=…`, which could be either cluster — is REFUSED. That is
// deliberate. Use the provider's devnet hostname (`devnet.helius-rpc.com`, and every provider has
// one), so the URL states its own cluster and the guard can agree with it.

import { BASE_RPC, ROUTER_URL } from "../../src/chain/constants.ts";
import { assertDevnetUrl, redactUrlSecrets } from "../../src/devnet-guard.ts";

/** Where an endpoint came from, so the boot banner can say. An operator debugging a rate limit needs
 *  to know whether the paid endpoint they set is actually the one in use, and "it is configured
 *  somewhere" is not an answer a log can give unless it says which. */
export interface Endpoint {
  url: string;
  fromEnv: boolean;
  /** The env var that would override it, named whether or not it is set — the log line is also the
   *  documentation for the operator reading it. */
  envName: string;
  /** What to call it in the banner. */
  label: string;
}

function resolve(envName: string, fallback: string, what: string, label: string): Endpoint {
  const raw = process.env[envName];
  // An empty string is treated as unset rather than as an empty URL. `fly secrets set X=` and an
  // unset var are the same intent, and `assertDevnetUrl("")` would otherwise refuse to start with a
  // message about guessing a cluster, which is a confusing way to say "you left it blank".
  const configured = raw !== undefined && raw.trim() !== "";
  const url = configured ? raw.trim() : fallback;
  // THE POINT OF THIS FILE. Runs on the env value and on the fallback alike — the fallback is already
  // asserted in constants.ts, and asserting it again here costs nothing and means this module's
  // contract ("nothing leaves here unasserted") is true by inspection rather than by knowing what
  // another module did on import.
  assertDevnetUrl(url, what);
  // PROVENANCE, NOT VALUE EQUALITY. `url !== fallback` was the obvious version and it is wrong in the
  // exact case that matters: `fly.toml` and the Dockerfile both set these variables to the default
  // values, so on every real deployment the endpoint IS env-supplied and a value comparison would
  // report "(default)" — the precise inversion of what this field exists to tell an operator.
  return { url, fromEnv: configured, envName, label };
}

/** The base-layer Solana RPC: the arena account, the round PDA's owner, block times for the clock,
 *  and every transaction that is not sent into the rollup. */
export const BASE_RPC_ENDPOINT = resolve("KEEPER_BASE_RPC", BASE_RPC, "base devnet RPC", "base rpc");

/** The MagicBlock Magic Router. Routes per account, so a delegated round comes back as the ER sees
 *  it — which for a live lobby or a live fight is every field that decides anything. */
export const ROUTER_ENDPOINT = resolve("KEEPER_ROUTER_URL", ROUTER_URL, "Magic Router", "router");

/** One line per endpoint for the boot banner, with any API key masked.
 *
 *  REDACTED THROUGH THE GUARD'S OWN REDACTOR, not a second regex written here: a log line that leaks
 *  the paid endpoint's key into `fly logs` — which is not a secret store — would be a worse outcome
 *  than the rate limit the key was bought to fix. */
export function describeEndpoints(): Array<{ label: string; text: string }> {
  return [BASE_RPC_ENDPOINT, ROUTER_ENDPOINT].map((endpoint) => ({
    label: endpoint.label,
    text: `${redactUrlSecrets(endpoint.url)}  ${endpoint.fromEnv ? `(${endpoint.envName})` : "(default)"}`,
  }));
}
