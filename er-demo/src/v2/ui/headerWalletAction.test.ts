import { describe, expect, it } from "vitest";
import type { PlayBlockCta } from "../data/playGate.ts";
import { headerWalletAction, type HeaderWalletAction } from "./headerWalletAction.ts";

/**
 * EVERY CTA KIND, WITH THE VERDICT IT IS OWED — as a total map rather than as a handful of `it`s,
 * and the totality is the point of the shape.
 *
 * `Record<PlayBlockCta["kind"], …>` is a COMPILE error the moment a fifth kind joins the union
 * without a line here (`tsconfig.app.json` includes `src`, so `npm run typecheck` covers this file),
 * and a missing property in an object literal is an error in any mode — which matters in a project
 * that deliberately does not set `strict`. That is the guarantee the brief asked for: a fifth kind
 * cannot be added silently, because adding one without deciding what the header should do with it
 * fails the build rather than quietly falling into `open-rail`.
 *
 * The runtime half is the loop below: every key is exercised, so a kind that is added here and given
 * the wrong verdict fails a test rather than shipping.
 */
const EVERY_KIND: Record<PlayBlockCta["kind"], HeaderWalletAction> = {
  // The one press that genuinely finishes the job.
  connect: "connect",
  // Leaves the page — needs an `<a>` and the sentence beside it.
  install: "open-rail",
  faucet: "open-rail",
  // Destroys the reader's page — needs the paragraph that says why that is the fix.
  retry: "open-rail",
};

/** A cta of a given kind, with the fields the verdict does not read filled in plausibly. The
 *  function must decide on `kind` alone; the label and href are here to prove it ignores them. */
function cta(kind: PlayBlockCta["kind"]): PlayBlockCta {
  return { kind, label: `press me (${kind})`, href: "https://example.invalid" };
}

describe("headerWalletAction", () => {
  it("connects on `connect`, and only on `connect`", () => {
    expect(headerWalletAction(cta("connect"))).toBe("connect");
    expect(headerWalletAction(cta("install"))).toBe("open-rail");
    expect(headerWalletAction(cta("faucet"))).toBe("open-rail");
    expect(headerWalletAction(cta("retry"))).toBe("open-rail");
  });

  it("has a decided verdict for every kind the gate can produce", () => {
    const kinds = Object.keys(EVERY_KIND) as PlayBlockCta["kind"][];
    // Guards the loop itself: an empty or half-built map would pass every assertion inside it.
    expect(kinds).toHaveLength(4);
    for (const kind of kinds) {
      expect(headerWalletAction(cta(kind))).toBe(EVERY_KIND[kind]);
    }
  });

  it("opens the rail when there is no route out at all", () => {
    // `connecting` and `no-program` both carry `cta: null` — nothing to press, and a panel that says
    // so. The header must not pretend otherwise.
    expect(headerWalletAction(null)).toBe("open-rail");
  });

  it("opens the rail when there is no gate, which reaches this as `undefined`", () => {
    // The call site is `gate?.cta`: a null gate optional-chains to `undefined`, not to `null`.
    expect(headerWalletAction(undefined)).toBe("open-rail");
  });

  it("ignores everything about the cta except its kind", () => {
    // A `connect` cta with no href and an empty label is still a connect; an `install` with a
    // connect-sounding label is still not one. The verdict is about what the press DOES.
    expect(headerWalletAction({ kind: "connect", label: "" })).toBe("connect");
    expect(headerWalletAction({ kind: "install", label: "Connect Phantom" })).toBe("open-rail");
  });
});
