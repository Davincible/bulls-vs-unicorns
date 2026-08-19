/* -------------------------------------------------------------------------------------------------
   THE NAME, WITH OR WITHOUT A FACE — one definition for every `.sc-who` row on the screens.
   -------------------------------------------------------------------------------------------------
   `SOCIAL.md` §2.5's rule, and it is the whole design: AN AVATAR REPLACES SOMETHING RATHER THAN
   FILLING A HOLE. A linked player's `@handle` and face are what stands in this slot; an unlinked
   player renders NOTHING IN IT — no reserved column, no placeholder, no silhouette, no grey
   person-icon and, since the pseudonym went, no invented word either. Those all read as broken, and
   `TWITTER-CONNECT.md` §8 is emphatic that the unlinked path is the MAIN path: most players never
   link, and the wallet key already on the row is a complete, good rendering of a player rather than a
   degraded one.

   IT RENDERS NOTHING RATHER THAN THE ADDRESS, and that is specific to the `.sc-who` layout. Every row
   that uses this cell ALREADY prints `.sc-who-k` beside it — the same truncated key — so returning it
   here would print the address twice on one row. The rule the rest of the page follows is that an
   unlinked row shows the address in the slot the pseudonym had; here the slot next door was already
   doing that job before the pseudonym was removed, and the honest response is to leave it alone. The
   surfaces with no such neighbour (the arena's fixed-track rows, the combat log, the wins ticker, the
   rail's heading) put the address in the slot itself and say so where they do it.

   NOTHING HERE NAGS. There is no "connect X" affordance on a row and there never may be — the connect
   control lives in the wallet panel, once (§4.0). A leaderboard that asks forty rows' worth of
   strangers to link is the growth tactic that document explicitly refuses.

   IT LIVES IN `views/` RATHER THAN `ui/`, AND THAT BOUNDARY IS THE REASON IT IS ITS OWN FILE. This
   renders `.sc-who-n`, which is a `screens.css` class — a `ui/` primitive has no business knowing
   about it. It was local to `LeaderboardView.tsx` while the three boards were its only callers, with
   a note saying a fourth surface should LIFT it rather than copy it; `HistoryView`'s round-detail
   table is that fourth surface, and this is that lift.

   THE DECISION IS NOT HERE. `data/namePlate.ts` decides what a name slot contains, for the whole
   page, including the surfaces that cannot render an element. This is only how the answer is set on
   these screens. Callers pass a `NamePlate`, never a wallet — which is what stops a second lookup,
   with a second opinion about verification, growing next to the first.
   ------------------------------------------------------------------------------------------------- */

import { XIdentity } from "../ui/XIdentity.tsx";
import type { NamePlate } from "../data/namePlate.ts";
import "./screens.css";

export function NameCell({ plate }: { plate: NamePlate }) {
  switch (plate.kind) {
    case "handle":
      return <XIdentity link={plate.link} />;
    // Unreachable from today's callers — every `.sc-who` row prints its own `you` marker beside this
    // cell and therefore passes `"beside"`. Handled rather than asserted away: an exhaustive switch
    // is what makes a fourth plate kind a compile error here instead of a silently blank cell.
    case "you":
      return <span className="sc-who-n">YOU</span>;
    case "none":
      return null;
  }
}
