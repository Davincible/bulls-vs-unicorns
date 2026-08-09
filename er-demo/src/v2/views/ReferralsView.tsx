// 03 — REFERRALS. The original game's referral programme, reproduced in full and marked, in full,
// as what it is: SIMULATED.
//
// There is no referral instruction in the arena program. It custodies nothing, so there is no house
// fee account to split and no attribution to record on chain — the link works (it carries a `ref`
// parameter), but the earnings counter is a local ledger in this browser and nothing more. The
// honest sentence is at the top of 03-2 where nobody can miss it, not in a footnote, because a
// money-shaped number with nothing behind it is the one thing this page must never ship.

import { useEffect, useState } from "react";
import { useArena } from "../data/useArena.ts";
import { Dash, KV, KVs, Section, Tag } from "../ui/primitives.tsx";
import { FEE_BPS, SIDE_TOKEN, usd, usdToUnits } from "../contract.ts";
import "./screens.css";

/** The referrer's cut of the house fee, matching the original game's 10%. */
const REFERRAL_SHARE_PCT = 10;

/** WHAT "10% OF THE HOUSE FEE" IS ACTUALLY WORTH, on a round number a player can hold in their head.
 *
 *  Stated because the headline rate is two big-sounding percentages of each other and of almost
 *  nothing: 10% of 0.20% is two hundredths of one percent of a deploy. A page that says "10% of the
 *  house fee" and stops has told the truth and left the reader with the wrong number. Priced through
 *  `usdToUnits`/`usd` like every other figure here rather than written out as a string, so it can
 *  never drift from `FEE_BPS`. */
const EXAMPLE_DEPLOY_USD = 100;
const EXAMPLE_HOUSE_FEE_USD = (EXAMPLE_DEPLOY_USD * FEE_BPS) / 10_000;
const EXAMPLE_SHARE_USD = (EXAMPLE_HOUSE_FEE_USD * REFERRAL_SHARE_PCT) / 100;

export function ReferralsView() {
  const { sim, you, toasts } = useArena();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sim.refLink);
      setCopied(true);
    } catch {
      // Clipboard access is refused outright in some browsers and over plain http. Say so rather
      // than flashing "copied" over a clipboard that never changed.
      toasts.push("Could not reach the clipboard — select the link and copy it by hand.", "error");
    }
  }

  const shareText = `I'm fighting in the ${SIDE_TOKEN[0].name} ⚔ ${SIDE_TOKEN[1].name} arena. Pick a side, raid the other one, extract before it ends.`;
  const shareHref = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(sim.refLink)}`;

  // `refLink` is `${origin}${pathname}?ref=${pubkey}` (see `useShell.ts`) — thirty-eight-odd
  // boilerplate characters every wallet shares, followed by the one part that is actually THIS
  // wallet's: the pubkey. At a 390px viewport the box is ~336px of usable width against a ~600px
  // string, so something has to give, and it should never be the pubkey — a trailing ellipsis
  // (the box's old behaviour) hides exactly the part a referrer needs to eyeball to know the link
  // is theirs. Splitting on `ref=` and giving the boring head an ellipsis while the pubkey tail
  // never shrinks reads, visually, as middle-truncation ("http://localhost:5…ref=MwMBw…t9KJ2")
  // without the jitter of measuring characters in JS: it is two flex children, sized by CSS alone,
  // so it holds at any width including 1440px where nothing needs to shrink at all. If the split
  // point isn't found (defensive — the format changed, or this is a non-`ref=` link some day), the
  // whole string goes in the head span and truncates the old way rather than silently disappearing.
  const REF_PARAM = "ref=";
  const refParamAt = sim.refLink.indexOf(REF_PARAM);
  const linkHead = refParamAt === -1 ? sim.refLink : sim.refLink.slice(0, refParamAt + REF_PARAM.length);
  const linkTail = refParamAt === -1 ? "" : sim.refLink.slice(refParamAt + REF_PARAM.length);

  const earned = sim.ledger.referralEarned;
  const count = sim.ledger.referralCount;

  return (
    <div className="scr">
      <header className="scr-head">
        <span className="idx">03</span>
        <div className="scr-head-main">
          <h1 className="display">Referrals</h1>
          {/* THE HONEST SENTENCE IS THE SECOND ONE, and it is here rather than only in 03-2 because a
              reader who takes one thing off this screen takes the lede. The programme is described
              in the tense it deserves: the rate is what the original game paid, and on this build
              there is no instruction that pays it. */}
          <p className="lede">
            Share your link and you are credited {REFERRAL_SHARE_PCT}% of the house fee on every
            round your signups play, for as long as they play. The link is real; the crediting is
            not — there is no referral instruction in the arena program, so every figure below is a
            local simulation and none of it is money.
          </p>
        </div>
        <div className="scr-head-meta">
          <span className="u">
            Provenance · <Tag kind="sim" />
          </span>
          <span className="u">
            Wallet · <span className="u--ink">{you.short}</span>
          </span>
          <span className="u">
            Rate · <span className="u--ink">{REFERRAL_SHARE_PCT}% of the house fee</span>
          </span>
        </div>
      </header>

      <Section
        index="03-1"
        title="Your link"
        lede="It carries your wallet as a ref parameter. Anyone who lands on it and deploys is attributed to you."
      >
        <div className="sc-linkrow sc-refmeasure">
          {/* The visible truncation is CSS-only — `linkHead`/`linkTail` are a straight character
              split of the real string, not a JS-shortened one, so there is nothing for a screen
              reader to lose. `text-overflow: ellipsis` clips paint, not the DOM: assistive tech
              reading this `<code>` in browse mode reads both spans' full text nodes regardless of
              what is visually clipped, so the announcement is already the complete url with no
              sr-only duplicate needed — a second hidden copy would only risk the url being read
              twice. `title` stays as the hover tooltip for sighted mouse users, who get no benefit
              from browse-mode text. */}
          <code className="sc-linkbox" title={sim.refLink}>
            <span className="sc-linkhead">{linkHead}</span>
            <span className="sc-linktail">{linkTail}</span>
          </code>
          <button type="button" className="btn" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            className="btn btn--fill"
            href={shareHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Share your referral link on X (opens a new tab)"
          >
            Share on X
          </a>
        </div>
        {/* The announcement lives in its own status region rather than on `aria-live` on the button.
            A control that is also a live region announces its own label changing, which is both the
            wrong event and the wrong words; this says what happened, once, and stays out of the tab
            order. It is empty until there is something to say so it never reads as a stray label. */}
        <p role="status" aria-live="polite" className="u" style={{ marginTop: 10, minHeight: 12 }}>
          {copied ? "Link copied to the clipboard" : ""}
        </p>
      </Section>

      <Section index="03-2" title="Earnings">
        <p className="lede" style={{ marginBottom: 18 }}>
          <b>Every figure in this section is simulated.</b> The arena program has no referral
          instruction and holds no fees, so there is nothing on chain to pay out of — these numbers
          come from a local ledger in this browser and reset when you clear it.
        </p>
        <div className="sc-refmeasure">
          <KVs>
            {/* WHY THE FIRST TWO CAN DASH. `count` is the one that decides it: nobody referred is an
                absence of data, and dashes. Once somebody HAS been referred, `earned` is a real
                figure even at zero — they signed up and have not played yet — so it prints $0.00
                rather than pretending the ledger has nothing in it. Reading `earned > 0` for this,
                as it did before, made a referred-but-idle signup look like no signup at all. */}
            <KV
              label="Earned so far · USD"
              value={count > 0 ? usd(usdToUnits(earned)) : <Dash />}
              title={count > 0 ? undefined : "Nothing referred from this browser yet"}
            />
            <KV label="Players referred" value={count > 0 ? String(count) : <Dash />} />
            <KV label="Your share of the fee" value={`${REFERRAL_SHARE_PCT}%`} />
            <KV label="House fee · per deploy" value={`${(FEE_BPS / 100).toFixed(2)}%`} />
          </KVs>
          <p className="lede sc-refnote">
            {REFERRAL_SHARE_PCT}% of a {(FEE_BPS / 100).toFixed(2)}% fee is{" "}
            <b>{usd(usdToUnits(EXAMPLE_SHARE_USD))} on a {usd(usdToUnits(EXAMPLE_DEPLOY_USD), 0)} deploy</b> —
            the rate is a share of the door, not of anyone's stake or winnings.{" "}
            {count > 0
              ? null
              : "Nothing has been referred from this browser, which is why the first two figures read — and not zero."}
          </p>
        </div>
      </Section>

      {/* "Four lines, no asterisks" was the old lede, and 03-3.4 is an asterisk — the biggest one on
          the page. Saying so is better copy than a claim the next paragraph disproves. */}
      <Section
        index="03-3"
        title="The deal"
        lede="Three lines describing the programme, and a fourth saying what it currently is."
      >
        <div className="sc-terms">
          <div className="sc-term">
            <span className="idx">03-3.1</span>
            <p>
              The house takes <b>{(FEE_BPS / 100).toFixed(2)}%</b> of every deploy. That is the only
              fee in the game, and it is taken once, at the door — nothing is skimmed off a raid, a
              payout or an extraction.
            </p>
          </div>
          <div className="sc-term">
            <span className="idx">03-3.2</span>
            <p>
              You keep <b>{REFERRAL_SHARE_PCT}% of that fee</b>, on every round your signups ever
              play. Not {REFERRAL_SHARE_PCT}% of their stake and not {REFERRAL_SHARE_PCT}% of their
              winnings — you are paid out of the house's cut, so a referral never costs the person
              you referred anything.
            </p>
          </div>
          <div className="sc-term">
            <span className="idx">03-3.3</span>
            {/* This line used to end "…and are yours to withdraw", which was the single most
                dangerous sentence on the screen: a withdrawal is an action against custody, and
                there is no custody. The accrual is real as a rule; the balance is a number in a
                browser tab. */}
            <p>
              It runs <b>forever</b>. There is no expiry window and no cap, and it is not paid in
              rounds — the balance accrues in dollars rather than in credits. In this build that
              balance is a counter in your own browser, and there is nothing behind it to withdraw
              from.
            </p>
          </div>
          <div className="sc-term">
            <span className="idx">03-3.4</span>
            <p>
              <b>None of this is on chain yet.</b> The arena program custodies no tokens, so it has
              no fee account to split and no way to record who referred whom. The link is real; the
              accounting behind it is a local simulation, and it is marked <Tag kind="sim" /> on
              every surface that shows it.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
