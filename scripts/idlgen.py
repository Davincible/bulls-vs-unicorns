#!/usr/bin/env python3
"""Regenerate the bulls-arena IDL from src/lib.rs.

MODES
  (none)                    regenerate the three IDL artefacts — REFUSES if that would change the
                            `Round` account layout the served IDL describes; see `round_layout`
  --verify                  check only, write nothing. What
                            `the_idl_generator_still_reproduces_the_committed_idl` runs on every
                            `cargo test`, so it must never need a network
  --deploying               the acknowledgement that permits a layout change, to be passed only in
                            the same operation that deploys the matching program
  --deployed-check <rpc>    ask the chain whether the SERVED IDL and the DEPLOYED program agree.
                            Opt-in, for after a deploy

`anchor idl build` cannot run on this machine (anchor-attribute-account's idl-build path fails to
compile under the pinned toolchain), so this reproduces the parts of it this change touches. Nothing
here is guessed:

  * discriminators are re-derived with anchor's rule and CHECKED against every one already in the
    file;
  * doc strings are EXTRACTED from lib.rs and checked against every doc block already in the file;
  * the camelCase .ts is produced by a transform proven to reproduce the committed .ts byte-for-byte;
  * every pubkey the output names is either this program or a NAMED external one — see
    `EXTERNAL_PROGRAMS` and `foreign_pubkeys`, and the incident that check exists because of.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

# ---- base58, because a program id lives in the IDL in TWO encodings ----------------------------
#
# Ten lines rather than a dependency: this script is run by `cargo test` on every developer machine
# and in CI, and a `pip install` standing between the test suite and the tool it depends on is a
# worse trade than the digit arithmetic below. Bitcoin's alphabet, which is Solana's.
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw):
    n = int.from_bytes(bytes(raw), "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    for b in raw:                      # leading zero bytes are leading '1's, not nothing
        if b:
            break
        out = "1" + out
    return out


def b58decode(text):
    n = 0
    for c in text:
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    pad = len(text) - len(text.lstrip("1"))
    return b"\x00" * pad + body


# ---- every pubkey in the IDL that is NOT this program -------------------------------------------
#
# An allowlist, and it is deliberately a list of NAMES rather than a pattern. Anything in the IDL
# that is not this program and not one of these is a bug — either a stale id left behind by a
# migration, or a program this one started talking to and nobody wrote down. Both are worth a failed
# build; the second costs one line to acknowledge.
EXTERNAL_PROGRAMS = {
    "11111111111111111111111111111111": "System",
    "SysvarS1otHashes111111111111111111111111111": "SlotHashes sysvar",
    "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh": "MagicBlock Delegation",
    "Magic11111111111111111111111111111111111111": "MagicBlock (commit/undelegate)",
    "MagicContext1111111111111111111111111111111": "MagicBlock context",
    "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz": "MagicBlock VRF oracle",
}


def pubkeys(idl):
    """Every pubkey the IDL names, with where it was found, in BOTH encodings anchor uses.

    Base58 `address` strings are the obvious one. The other is a raw 32-byte array under a `pda`'s
    `program` — that is how anchor writes "derive this PDA under a program that is not the one
    declaring the instruction", and it is the encoding that got missed twice (see `retarget`)."""
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "address" and isinstance(v, str):
                    found.append((v, f"{path}/address"))
                elif k == "program" and isinstance(v, dict) and v.get("kind") == "const" \
                        and isinstance(v.get("value"), list) and len(v["value"]) == 32:
                    found.append((b58encode(v["value"]), f"{path}/program"))
                else:
                    walk(v, f"{path}/{k}")
        elif isinstance(node, list):
            for n, x in enumerate(node):
                walk(x, f"{path}[{n}]")

    walk(idl, "")
    return found


def foreign_pubkeys(idl, this_program):
    return [(k, at) for k, at in pubkeys(idl) if k != this_program and k not in EXTERNAL_PROGRAMS]


# ---- the account layout, and why this file is not a build artefact -------------------------------
#
# `er-demo/public/idl/bulls_arena.json` IS FETCHED BY THE LIVE PAGE AT RUNTIME. It is not a build
# output of this source tree — it is a CONTRACT WITH THE PROGRAM THAT IS CURRENTLY DEPLOYED, and the
# two are only legitimately in step at the moment of a deploy.
#
# This was learned the expensive way. `Round` gained `fees_collected` and `house_swept` in lib.rs, the
# generator was run, and all three artefacts were rewritten to describe a 17-field `Round` while the
# deployed program still had the 15-field one. Anchor decodes by IDL, so borsh walked off the end of
# every real round account and the page died with `Invalid bool: 205` — mid-demo, with a keeper
# cycling rounds. Nothing in this script objected, because from its point of view it had done exactly
# what it was asked.
#
# So it objects now. The guard is deliberately LOCAL and always on: the served copy on disk is itself
# the best available description of what is deployed, so a run that would change the account layout it
# describes is a run that is about to break whatever is talking to that program. `--deploying` is the
# acknowledgement, named after the only operation during which the change is safe.
SCALARS = {
    "bool": 1, "u8": 1, "i8": 1, "u16": 2, "i16": 2, "u32": 4, "i32": 4, "f32": 4,
    "u64": 8, "i64": 8, "f64": 8, "u128": 16, "i128": 16, "pubkey": 32,
}


def type_size(ty, types):
    if isinstance(ty, str):
        if ty not in SCALARS:
            raise SystemExit(f"idlgen cannot size the IDL type {ty!r} — teach `type_size` about it")
        return SCALARS[ty]
    if "array" in ty:
        inner, count = ty["array"]
        return type_size(inner, types) * count
    if "defined" in ty:
        return struct_size(types[ty["defined"]["name"]], types)
    raise SystemExit(f"idlgen cannot size the IDL type {ty!r} — teach `type_size` about it")


def struct_size(entry, types):
    return sum(type_size(f["type"], types) for f in entry["type"]["fields"])


def round_layout(idl):
    """(field names, on-chain account size) for `Round`, as the IDL describes it.

    The size includes anchor's 8-byte discriminator, so it is directly comparable to the `data.len()`
    of a real account and to `Round::SIZE` in lib.rs — which is exactly the comparison that matters."""
    types = {t["name"]: t for t in idl["types"]}
    rnd = types["Round"]
    return tuple(f["name"] for f in rnd["type"]["fields"]), 8 + struct_size(rnd, types)

# Repo-relative, not an absolute path: this lives in `scripts/` now, and a hardcoded home directory
# is the difference between a tool the next person can run and one that silently rewrites nothing.
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "programs/bulls-arena/src/lib.rs"
IDL_JSON = ROOT / "programs/bulls-arena/idl/bulls_arena.json"
IDL_TS = ROOT / "programs/bulls-arena/idl/bulls_arena.ts"
PUBLIC_JSON = ROOT / "er-demo/public/idl/bulls_arena.json"

TS_HEADER = (
    "/**\n * Program IDL in camelCase format in order to be used in JS/TS.\n *\n"
    " * Note that this is only a type helper and is not the actual IDL. The original\n"
    " * IDL can be found at `target/idl/bulls_arena.json`.\n */\n"
)


# ---- anchor's discriminator rule ---------------------------------------------------------------
def disc(prefix, name):
    return list(hashlib.sha256(f"{prefix}:{name}".encode()).digest()[:8])


# ---- doc extraction ----------------------------------------------------------------------------
class Source:
    def __init__(self, text):
        self.lines = text.splitlines()

    def docs_above(self, index, extra_ends=()):
        """The `///` block above `index`, as anchor emits it (leading `/// ` stripped).

        Attribute lines sit between the block and the item and can span several lines
        (`#[session_auth_or(...)]` on `enter`/`extract`), so anything that is not a doc line is
        skipped until either a doc line or the end of the previous item is reached. A blank line or a
        closing brace means the item has no doc block at all.

        A line ENDING in `}` is a boundary too, not just one starting with it. The `#[event]` structs
        are each declared on a single line, so a preceding sibling is a complete item that both opens
        and closes on its own line. Stopping only at a LEADING `}` walked straight over it and handed
        `SeedRevealed` and `RoundSettled` the doc block belonging to `RoundAbandoned` above them —
        silently, since every name still resolved. Undocumented items must come back empty.

        `extra_ends` EXISTS BECAUSE THE BOUNDARY IS NOT THE SAME EVERYWHERE, and the second instance
        of the bug above proved it. Inside a STRUCT, the previous item is a field, and a field ends
        in a COMMA — so an undocumented field walks straight over its documented predecessor and
        inherits that field's doc block. It did: `Treasury.bump` came out of the generator carrying
        `rounds_swept`'s prose, silently, exactly as `SeedRevealed` had. But `,` cannot simply join
        the list for every caller, because a multi-line attribute has comma-terminated lines of its
        own (`#[session_auth_or(` on `enter` and `extract`) and treating those as boundaries would
        strip the doc block off the two most heavily documented instructions in the program.

        So the caller says which rule applies: `struct_field_docs` passes `,` and nothing else does.
        Two contexts with genuinely different boundaries, named rather than averaged into one rule
        that is wrong in one of them."""
        i = index - 1
        while i >= 0 and not self.lines[i].strip().startswith("///"):
            s = self.lines[i].strip()
            if s == "" or s.startswith("}") or s.endswith("}") or s.endswith(";") or s.endswith("{") \
                    or any(s.endswith(e) for e in extra_ends):
                return []
            i -= 1
        out = []
        while i >= 0 and self.lines[i].strip().startswith("///"):
            s = self.lines[i].strip()[3:]
            out.append(s[1:] if s[:1] == " " else s)
            i -= 1
        return list(reversed(out))

    def find(self, pattern):
        rx = re.compile(pattern)
        for i, line in enumerate(self.lines):
            if rx.search(line):
                return i
        return None

    def event_docs(self, name):
        """`#[event] pub struct X { ... }` is a one-liner in this source, so the block sits directly
        above the attribute line."""
        at = self.find(rf"^#\[event\] pub struct {name} ")
        return None if at is None else self.docs_above(at)

    def fn_docs(self, name):
        at = self.find(rf"^\s*pub fn {name}\(")
        return None if at is None else self.docs_above(at)

    def struct_field_docs(self, struct, field):
        i = self.find(rf"^pub struct {struct} \{{") + 1
        while i < len(self.lines) and not self.lines[i].startswith("}"):
            if re.match(rf"^\s*pub {field}:", self.lines[i]):
                return self.docs_above(i, extra_ends=(",",))
            i += 1
        return None

    def struct_docs(self, name):
        """The block above `pub struct X {`, which anchor emits on the TYPE. `#[account]` sits
        between the two and is skipped by `docs_above` like any other attribute line."""
        at = self.find(rf"^pub struct {name} \{{")
        return None if at is None else self.docs_above(at)


HEAD = Source(subprocess.run(
    ["git", "-C", str(ROOT), "show", "HEAD:programs/bulls-arena/src/lib.rs"],
    check=True, capture_output=True, text=True).stdout)
NOW = Source(SRC.read_text(encoding="utf-8"))
fn_docs = NOW.fn_docs
struct_field_docs = NOW.struct_field_docs
struct_docs = NOW.struct_docs
event_docs = NOW.event_docs


# ---- what this generator rewrites from source ---------------------------------------------------
#
# ONE list, read by both `patch` and `verify`, because they are two halves of the same statement.
# `patch` regenerates these items' docs out of lib.rs; `verify` therefore must NOT hold them against
# the committed IDL, since a difference there is exactly the staleness the generator exists to fix,
# not evidence the extractor is broken. Kept together so the two can never disagree about which is
# which — as they did when a doc block was edited in lib.rs and committed without regenerating, and
# `verify` failed on `Round.lobby_opened_at` in a way that blocked the only tool that could fix it.
REGENERATED_FNS = {
    "open_round", "enter", "close_lobby_and_draw",
    # The house's books. Added to the set on the same run that adds them to the IDL, not later: an
    # item inserted by `patch` under an `if name not in ix` guard is written ONCE and never refreshed,
    # so the first edit to its doc block would fail `verify` with no way to regenerate past it. That
    # is precisely how `Round.lobby_opened_at` blocked the tool that was the only fix for it.
    "set_fee_bps", "init_treasury", "sweep_house_take",
}
REGENERATED_EVENTS = {"RoundOpened", "RoundAbandoned", "Entered", "HouseSwept", "FeeBpsChanged"}
REGENERATED_ROUND_FIELDS = {"lobby_opened_at", "fees_collected", "house_swept"}


def declared_id():
    """The `declare_id!` in the CURRENT lib.rs — the one place a program id is written by hand.

    The IDL's `address` is derived from it rather than carried forward from the committed file, so a
    new deployment's id reaches all three IDL artefacts by editing `declare_id!` alone. `idl.ts`
    asserts it at runtime against `constants.ts`, so a half-propagated id fails loudly at import."""
    m = re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', SRC.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit("no declare_id! found in lib.rs")
    return m.group(1)


# ---- verification against the committed file ---------------------------------------------------
def verify(idl):
    problems = []
    for i in idl["instructions"]:
        if disc("global", i["name"]) != i["discriminator"]:
            problems.append(f"instruction discriminator {i['name']}")
    for a in idl["accounts"]:
        if disc("account", a["name"]) != a["discriminator"]:
            problems.append(f"account discriminator {a['name']}")
    for e in idl["events"]:
        if disc("event", e["name"]) != e["discriminator"]:
            problems.append(f"event discriminator {e['name']}")

    # every instruction's docs must come back out of lib.rs unchanged
    for i in idl["instructions"]:
        if i["name"] == "process_undelegation":
            continue  # injected by #[ephemeral], not written in this source
        if i["name"] in REGENERATED_FNS:
            continue  # rewritten from source by patch(); see REGENERATED_FNS
        got = HEAD.fn_docs(i["name"])
        if got is not None and got != i.get("docs", []):
            problems.append(f"docs for instruction {i['name']}:\n  idl={i.get('docs')}\n  src={got}")

    # ...every event type's docs, which anchor emits on the type rather than the event entry
    for t in idl["types"]:
        if t["name"] in {e["name"] for e in idl["events"]} and t["name"] not in REGENERATED_EVENTS:
            got = HEAD.event_docs(t["name"])
            if got is not None and got != t.get("docs", []):
                problems.append(f"docs for event {t['name']}:\n  idl={t.get('docs')}\n  src={got}")

    # ...and every documented field of Round
    rnd = next(t for t in idl["types"] if t["name"] == "Round")
    for f in rnd["type"]["fields"]:
        if "docs" not in f or f["name"] in REGENERATED_ROUND_FIELDS:
            continue
        got = HEAD.struct_field_docs("Round", f["name"])
        if got is not None and got != f["docs"]:
            problems.append(f"docs for Round.{f['name']}:\n  idl={f['docs']}\n  src={got}")
    return problems


# ---- camelCase transform (proven byte-identical against the committed .ts) ----------------------
def camel(s):
    parts = s.split("_")
    s2 = parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])
    return s2[:1].lower() + s2[1:]


def to_camel(node):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k == "relations" and isinstance(v, list):
                out[k] = [camel(x) for x in v]
            elif k in ("name", "path") and isinstance(v, str):
                out[k] = camel(v)
            else:
                out[k] = to_camel(v)
        return out
    if isinstance(node, list):
        return [to_camel(x) for x in node]
    return node


# ---- the patch ---------------------------------------------------------------------------------
def patch(idl):
    ix = {i["name"]: i for i in idl["instructions"]}
    types = {t["name"]: t for t in idl["types"]}

    # 0. the program id, from `declare_id!` rather than carried over from the committed IDL — a fresh
    #    deployment changes it in one place and it reaches all three IDL artefacts from there.
    #
    #    EVERY OCCURRENCE, IN EVERY ENCODING, AND THIS HAS NOW BEEN GOT WRONG TWICE FROM THE SAME
    #    ROOT CAUSE — a rule phrased in terms of where the id was expected to appear rather than what
    #    the id IS.
    #
    #      * First miss: `delegate_round.owner_program` is declared `address = crate::ID`, so anchor
    #        emits this program's id a second time inside an account list. A retarget that rewrote
    #        only the top-level `address` field left it pinned to the previous deployment.
    #      * Second miss, fixed here: `delegate_round.buffer_round_pda.pda.program` is a raw 32-BYTE
    #        ARRAY, not a base58 string, so the string-matching rule that fixed the first one walked
    #        straight past it. It sat pinned to v4 (CchN3JPWta2uVxKhwScBQhtPG5gpsaRzf3RA4aPCDam2)
    #        while `declare_id!` said v5. Anything deriving that PDA through anchor's IDL resolver
    #        computed the buffer address under the wrong program and the deployed program rejected
    #        the transaction with `ConstraintSeeds` — latent only because the demo path derives the
    #        delegation PDAs through the ephemeral-rollups SDK instead of the resolver.
    #
    #    Neither was caught downstream, and it is worth being precise about why: `er-demo/src/chain/
    #    idl.ts` asserts at runtime that `idl.address` matches `constants.ts`. That assertion is
    #    weaker than it looks — it checks exactly the ONE site both bugs were not in.
    #
    #    So the rule is now about identity, not location: walk the whole document, and rewrite any
    #    pubkey in either encoding that is neither an external program nor already the current id.
    #    A third encoding or a third site cannot escape it, and `foreign_pubkeys` asserts the
    #    post-condition afterwards so that if one ever does, the build says so.
    #    Mutated in place, because `ix`/`types` above alias these same dicts.
    new_id = declared_id()
    new_bytes = list(b58decode(new_id))

    def retarget(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "address" and isinstance(v, str):
                    if v != new_id and v not in EXTERNAL_PROGRAMS:
                        node[k] = new_id
                elif k == "program" and isinstance(v, dict) and v.get("kind") == "const" \
                        and isinstance(v.get("value"), list) and len(v["value"]) == 32:
                    if b58encode(v["value"]) not in EXTERNAL_PROGRAMS:
                        v["value"] = list(new_bytes)
                else:
                    retarget(v)
        elif isinstance(node, list):
            for x in node:
                retarget(x)

    retarget(idl)

    # 1. every instruction whose doc comment changed picks the new text straight out of lib.rs
    for name in ("open_round", "enter", "close_lobby_and_draw"):
        ix[name]["docs"] = fn_docs(name)

    # 2. open_round takes the lobby duration
    args = ix["open_round"]["args"]
    if not any(a["name"] == "lobby_seconds" for a in args):
        args.append({"name": "lobby_seconds", "type": "u32"})

    # 3. abandon_round — same accounts as close_round (both are Context<Resolve>)
    if "abandon_round" not in ix:
        idl["instructions"].append({
            "name": "abandon_round",
            "docs": fn_docs("abandon_round"),
            "discriminator": disc("global", "abandon_round"),
            "accounts": json.loads(json.dumps(ix["close_round"]["accounts"])),
            "args": [],
        })

    # 4. Round grows two timestamps, in front of fight_started_at
    fields = types["Round"]["type"]["fields"]
    if not any(f["name"] == "lobby_closes_at" for f in fields):
        at = next(n for n, f in enumerate(fields) if f["name"] == "fight_started_at")
        fields[at:at] = [
            {"name": "lobby_opened_at", "docs": struct_field_docs("Round", "lobby_opened_at"), "type": "i64"},
            {"name": "lobby_closes_at", "type": "i64"},
        ]
    # Refresh the docs UNCONDITIONALLY, not only on the run that inserts the fields. That block is a
    # one-shot migration; this doc block is long-lived and gets edited (the skew measurement landed in
    # it), and while the refresh lived inside the `if` the generator had no path to propagate any
    # later edit — it would insert the field once and never touch its docs again.
    next(f for f in fields if f["name"] == "lobby_opened_at")["docs"] = struct_field_docs("Round", "lobby_opened_at")

    # 5. RoundOpened carries the deadline; RoundAbandoned is new
    types["RoundOpened"]["docs"] = event_docs("RoundOpened")
    ro = types["RoundOpened"]["type"]["fields"]
    if not any(f["name"] == "lobby_closes_at" for f in ro):
        ro.append({"name": "lobby_opened_at", "type": "i64"})
        ro.append({"name": "lobby_closes_at", "type": "i64"})
    if "RoundAbandoned" not in types:
        idl["events"].append({"name": "RoundAbandoned", "discriminator": disc("event", "RoundAbandoned")})
        idl["types"].append({
            "name": "RoundAbandoned",
            "docs": event_docs("RoundAbandoned"),
            "type": {"kind": "struct", "fields": [
                {"name": "round_no", "type": "u64"},
                {"name": "fighter_count", "type": "u16"},
            ]},
        })

    # 6. the errors, appended so no existing code moves
    have = {e["name"] for e in idl["errors"]}
    for code, name, msg in (
        (6014, "LobbyClosed", "the lobby deadline has passed — this round is no longer taking entries"),
        (6015, "LobbyStillOpen", "the lobby deadline has not passed and the round is not full"),
        (6016, "LobbyNotAbandonable", "this lobby can still become a fight — it may not be abandoned"),
        (6017, "RoundNotTerminal", "this round has not finished — its house take cannot be swept yet"),
        (6018, "AlreadySwept", "this round's house take has already been swept"),
        (6019, "NotTheAuthority", "only the arena's authority may close a lobby before its deadline"),
    ):
        if name not in have:
            idl["errors"].append({"code": code, "name": name, "msg": msg})

    # ---- 7. THE HOUSE'S BOOKS --------------------------------------------------------------------
    #
    # `enter` charged a fee, subtracted it from the player and dropped it on the floor — see
    # `Round.fees_collected` in lib.rs. Recording it, sweeping it and re-pricing it add two `Round`
    # fields, one account, three instructions and three events, all of them below.
    ARENA_SEED, ROUND_SEED, TREASURY_SEED = list(b"arena"), list(b"round"), list(b"treasury")
    arena_pda = {"seeds": [{"kind": "const", "value": ARENA_SEED}]}
    treasury_pda = {"seeds": [
        {"kind": "const", "value": TREASURY_SEED},
        {"kind": "account", "path": "arena"},
    ]}
    round_pda = {"seeds": [
        {"kind": "const", "value": ROUND_SEED},
        {"kind": "account", "path": "arena"},
        {"kind": "arg", "path": "round_no"},
    ]}
    SYSTEM = "11111111111111111111111111111111"

    # `relations` names the account carrying the `has_one`, hung on the account it points AT — the
    # same shape `open_round` already shows (`authority` carries `relations: ["arena"]` because
    # `arena` is declared `has_one = authority`).
    for name, accounts, args in (
        ("set_fee_bps", [
            {"name": "arena", "writable": True, "pda": arena_pda},
            {"name": "authority", "signer": True, "relations": ["arena"]},
        ], [{"name": "fee_bps", "type": "u16"}]),
        ("init_treasury", [
            {"name": "arena", "pda": arena_pda},
            {"name": "treasury", "writable": True, "pda": treasury_pda},
            {"name": "authority", "writable": True, "signer": True, "relations": ["arena"]},
            {"name": "system_program", "address": SYSTEM},
        ], []),
        ("sweep_house_take", [
            {"name": "arena", "pda": arena_pda, "relations": ["round", "treasury"]},
            {"name": "round", "writable": True, "pda": round_pda},
            {"name": "treasury", "writable": True, "pda": treasury_pda},
        ], [{"name": "round_no", "type": "u64"}]),
    ):
        if name not in ix:
            idl["instructions"].append({
                "name": name,
                "discriminator": disc("global", name),
                "accounts": accounts,
                "args": args,
            })
            ix[name] = idl["instructions"][-1]
        # Docs refreshed on EVERY run, not only the one that inserts — see REGENERATED_FNS.
        ix[name]["docs"] = fn_docs(name)

    # ---- 8. THE AUTHORITY'S EARLY CLOSE ----------------------------------------------------------
    #
    # `close_lobby_and_draw` gained two accounts so a keeper can hold ONE lobby open and start the
    # fight the moment a real player joins, instead of cycling rounds on a timer and locking a round's
    # rent every cycle. `arena` supplies `arena.authority`; `authority` is the optional signer that
    # says the operator chose this moment rather than the clock. See `draw_is_permitted` in lib.rs.
    #
    # Inserted at their declared positions rather than appended: anchor emits accounts in declaration
    # order and clients that pass a positional array — `er-roundtrip.mjs` and the canary build account
    # lists by hand — depend on that order matching the program's.
    draw = ix["close_lobby_and_draw"]["accounts"]
    if not any(a["name"] == "arena" for a in draw):
        at = next(n for n, a in enumerate(draw) if a["name"] == "round")
        draw.insert(at, {"name": "arena", "pda": arena_pda, "relations": ["round"]})
    if not any(a["name"] == "authority" for a in draw):
        at = next(n for n, a in enumerate(draw) if a["name"] == "oracle_queue") + 1
        draw.insert(at, {"name": "authority", "signer": True, "optional": True})

    # Treasury: a new account type, so both the discriminator list and the type list.
    if not any(a["name"] == "Treasury" for a in idl["accounts"]):
        idl["accounts"].append({"name": "Treasury", "discriminator": disc("account", "Treasury")})
        idl["accounts"].sort(key=lambda x: x["name"])
    if "Treasury" not in types:
        idl["types"].append({"name": "Treasury", "type": {"kind": "struct", "fields": [
            {"name": "arena", "type": "pubkey"},
            {"name": "fees_accrued", "type": "u64"},
            {"name": "penalties_accrued", "type": "u64"},
            {"name": "rounds_swept", "type": "u64"},
            {"name": "bump", "type": "u8"},
        ]}})
        types["Treasury"] = idl["types"][-1]
    types["Treasury"]["docs"] = struct_docs("Treasury")
    for f in types["Treasury"]["type"]["fields"]:
        docs = struct_field_docs("Treasury", f["name"])
        if docs:
            f["docs"] = docs

    # Round grows the fee counter and the swept flag, both in front of seed_commit — the same place
    # they sit in the Rust, because borsh field order IS the account layout and `verify-session-
    # extract.mjs` decodes those bytes by hand.
    fields = types["Round"]["type"]["fields"]
    if not any(f["name"] == "fees_collected" for f in fields):
        at = next(n for n, f in enumerate(fields) if f["name"] == "seed_commit")
        fields[at:at] = [
            {"name": "fees_collected", "type": "u64"},
            {"name": "house_swept", "type": "bool"},
        ]
    for name in ("fees_collected", "house_swept"):
        next(f for f in fields if f["name"] == name)["docs"] = struct_field_docs("Round", name)

    for name, ev_fields in (
        ("Entered", [
            {"name": "round_no", "type": "u64"},
            {"name": "player", "type": "pubkey"},
            {"name": "side", "type": "u8"},
            {"name": "stake", "type": "u64"},
            {"name": "fee", "type": "u64"},
        ]),
        ("HouseSwept", [
            {"name": "round_no", "type": "u64"},
            {"name": "fees", "type": "u64"},
            {"name": "penalties", "type": "u64"},
            {"name": "fees_accrued", "type": "u64"},
            {"name": "penalties_accrued", "type": "u64"},
        ]),
        ("FeeBpsChanged", [
            {"name": "arena", "type": "pubkey"},
            {"name": "previous", "type": "u16"},
            {"name": "current", "type": "u16"},
        ]),
    ):
        if name not in types:
            idl["events"].append({"name": name, "discriminator": disc("event", name)})
            idl["types"].append({"name": name, "type": {"kind": "struct", "fields": ev_fields}})
            types[name] = idl["types"][-1]
        types[name]["docs"] = event_docs(name)

    # anchor emits each list sorted by name
    idl["instructions"].sort(key=lambda x: x["name"])
    idl["events"].sort(key=lambda x: x["name"])
    idl["types"].sort(key=lambda x: x["name"])
    idl["errors"].sort(key=lambda x: x["code"])
    return idl


def deployed_check(idl, rpc_url):
    """Does the DEPLOYED program's live `Round` accounts match the layout this IDL describes?

    The local guard in `main` compares against the served copy, which is a good proxy and always
    available. This is the real question, and it can only be answered by the chain — so it is opt-in
    and belongs to the deploy, not to `cargo test`, which must not need a network.

    Asked WITHOUT decoding anything: count the program's `Round` accounts by discriminator, then
    count them again with a `dataSize` filter for the expected size. Equal counts means every live
    round is the shape this IDL claims. A shortfall names exactly how many are not."""
    import urllib.request

    _, size = round_layout(idl)
    program = idl["address"]
    disc_b58 = b58encode(disc("account", "Round"))

    def count(filters):
        req = urllib.request.Request(
            rpc_url,
            data=json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "getProgramAccounts",
                # `dataSlice` length 0 so the RPC returns no account bytes at all — this asks how
                # MANY and how BIG, never for the contents.
                "params": [program, {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0},
                                     "filters": filters}],
            }).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
        if "error" in body:
            raise SystemExit(f"RPC error from {rpc_url}: {body['error']}")
        return len(body["result"])

    by_disc = [{"memcmp": {"offset": 0, "bytes": disc_b58}}]
    total = count(by_disc)
    matching = count(by_disc + [{"dataSize": size}])

    if total == 0:
        print(f"deployed-check: {program} has no Round accounts on {rpc_url} — nothing to compare "
              f"against. Open one round and re-run; an unanswered check is not a passed one.")
        sys.exit(1)
    if matching != total:
        print(f"DEPLOYED-CHECK FAILED — the IDL describes a {size} B Round, but {total - matching} "
              f"of {total} live Round accounts of {program} are a different size.\n"
              f"The deployed program and this IDL are not the same program. Publishing this IDL "
              f"breaks every client that decodes a live round.", file=sys.stderr)
        sys.exit(1)
    print(f"deployed-check: all {total} live Round accounts of {program} are {size} B — the IDL and "
          f"the deployed program agree")


def main():
    if "--deployed-check" in sys.argv:
        at = sys.argv.index("--deployed-check")
        if at + 1 >= len(sys.argv):
            raise SystemExit("--deployed-check needs an RPC url, e.g. https://api.devnet.solana.com")
        # The SERVED idl, not a regenerated one: the question is whether what clients are actually
        # fetching matches what is actually deployed.
        deployed_check(json.loads(PUBLIC_JSON.read_text(encoding="utf-8")), sys.argv[at + 1])
        return
    regenerate()


def regenerate():
    # ALWAYS start from the IDL at HEAD, never from whatever is on disk, so the output is a pure
    # function of (the committed IDL, the current lib.rs) and re-running is idempotent by
    # construction. Verifying against the on-disk file would flag this script's own edits as drift.
    idl = json.loads(subprocess.run(
        ["git", "-C", str(ROOT), "show", "HEAD:programs/bulls-arena/idl/bulls_arena.json"],
        check=True, capture_output=True, text=True).stdout)
    problems = verify(idl)
    if problems:
        print("VERIFICATION FAILED — the generator does not reproduce the committed IDL:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print(f"verified: {len(idl['instructions'])} instruction docs + discriminators, "
          f"{len(idl['accounts'])} account and {len(idl['events'])} event discriminators, "
          f"Round's field docs — all reproduce the committed IDL exactly")

    # THE PUBKEY POST-CONDITION, and it is checked on the OUTPUT rather than on the committed input
    # on purpose. Held against the committed IDL it would be a precondition — and it would have been
    # a failing one for as long as the stale v4 byte array sat in the file, blocking `cargo test` and
    # therefore blocking the only tool that could fix it. That is the trap `REGENERATED_FNS` exists
    # to document, and repeating it here would be worse: this check is meant to be run by everyone,
    # forever, not to be a one-off migration gate. As a post-condition it is unfalsifiable-by-
    # staleness — `patch` has already retargeted by the time it runs — and it fails only when
    # `retarget` genuinely missed something, which is exactly the bug it exists for.
    #
    # Under `--verify` the patch runs in memory and nothing is written, so `cargo test` gets the
    # check without the side effects.
    idl = patch(idl)
    this_program = declared_id()
    foreign = foreign_pubkeys(idl, this_program)
    if foreign:
        print(f"VERIFICATION FAILED — the IDL names pubkeys that are neither {this_program} nor a "
              f"known external program (see EXTERNAL_PROGRAMS):")
        for key, at in foreign:
            print(f"  - {key} at {at}")
        sys.exit(1)
    named = {k for k, _ in pubkeys(idl)} & set(EXTERNAL_PROGRAMS)
    print(f"program ids: every pubkey in the output is {this_program} or one of "
          f"{len(named)} named external programs")
    fields, size = round_layout(idl)
    print(f"Round layout: {len(fields)} fields, {size} B on chain")
    if "--verify" in sys.argv:
        return

    # THE LAYOUT GUARD. See `round_layout` for the incident. The served copy on disk describes the
    # program that is actually deployed; if this run would change that description, it is about to
    # break every client decoding a live account, and it must not do so by default.
    served_fields, served_size = round_layout(json.loads(PUBLIC_JSON.read_text(encoding="utf-8")))
    if (fields, size) != (served_fields, served_size) and "--deploying" not in sys.argv:
        added = [f for f in fields if f not in served_fields]
        removed = [f for f in served_fields if f not in fields]
        print(
            "REFUSING TO WRITE — this would change the `Round` account layout that the SERVED IDL\n"
            "describes, and the served IDL is a contract with the program that is DEPLOYED, not a\n"
            "build artefact of this source tree.\n"
            f"  served (deployed): {len(served_fields)} fields, {served_size} B\n"
            f"  generated (this working tree): {len(fields)} fields, {size} B\n"
            f"  added: {added or 'none'}\n"
            f"  removed: {removed or 'none'}\n"
            "\n"
            "`er-demo/public/idl/bulls_arena.json` is fetched by the live page at runtime. Anchor\n"
            "decodes by IDL, so publishing a layout the deployed program does not have makes borsh\n"
            "walk off the end of every real round account — observed as `Invalid bool: 205`, with the\n"
            "page unable to read any live round.\n"
            "\n"
            "If you are deploying the matching program IN THIS OPERATION, re-run with --deploying.\n"
            "Otherwise leave the IDL describing what is deployed and regenerate at deploy time.\n"
            "After deploying, `--deployed-check <rpc-url>` confirms the two are actually in step.",
            file=sys.stderr,
        )
        sys.exit(1)

    body = json.dumps(idl, indent=2, ensure_ascii=False) + "\n"
    IDL_JSON.write_text(body, encoding="utf-8")
    PUBLIC_JSON.write_text(body, encoding="utf-8")
    IDL_TS.write_text(
        TS_HEADER + "export type BullsArena = " + json.dumps(to_camel(idl), indent=2, ensure_ascii=False) + ";\n\n",
        encoding="utf-8",
    )
    print("wrote", IDL_JSON, PUBLIC_JSON, IDL_TS, sep="\n  ")


if __name__ == "__main__":
    main()
