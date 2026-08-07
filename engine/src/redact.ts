// Strip secrets out of anything that might reach a log, a client, or a public endpoint.
//
// This exists because /memo returned a raw error string on a public CORS:* endpoint, and Node's
// fetch errors routinely embed the full request URL — which for us carries the Helius API key. The
// same class of mistake already shipped once, when the keyed RPC was broadcast to every browser.
// Treat every outbound string as untrusted until it has been through here.
const SECRET_QS = /([?&](?:api[-_]?key|key|token|secret|auth|password|access[-_]?token)=)[^&\s"']+/gi;
const URL_WITH_QS = /(https?:\/\/[^\s"']+\?)[^\s"']+/gi;
// A byte-array key as it appears in config or env: "[12,34,...]" with 64 entries.
const KEY_ARRAY = /\[(?:\s*\d{1,3}\s*,){60,}\s*\d{1,3}\s*\]/g;

// We deliberately do NOT redact "any long base58 string". A base58 secret key and a transaction
// SIGNATURE are both ~88 characters and indistinguishable by shape, so a length rule would destroy
// lastSig — public data we actively need. Instead we redact the exact secret material we hold,
// which is precise and cannot swallow legitimate output.
const SECRET_ENV = ["VAULT_SECRET_KEY", "SESSION_SECRET", "JUPITER_API_KEY", "SOLANA_RPC"];
function literalSecrets(): string[] {
  const out: string[] = [];
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (!v || v.length < 16) continue;
    out.push(v);
    // SOLANA_RPC is a URL; also catch just its credential portion, which is what tends to appear
    const m = v.match(/[?&](?:api[-_]?key|key|token)=([^&\s]+)/i);
    if (m && m[1] && m[1].length >= 8) out.push(m[1]);
  }
  return out;
}

/** Redact a single string. Safe to call on anything, including null/undefined. */
export function redact(input: unknown): string {
  let s = String(input ?? "");
  s = s.replace(SECRET_QS, "$1***");
  // any surviving query string on a URL could still carry a credential we did not name
  s = s.replace(URL_WITH_QS, "$1***");
  s = s.replace(KEY_ARRAY, "[***]");
  for (const secret of literalSecrets()) {
    if (secret && s.includes(secret)) s = s.split(secret).join("***");
  }
  return s;
}

/** Redact recursively through an object destined for a client or a log. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}
