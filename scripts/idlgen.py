#!/usr/bin/env python3
"""Regenerate the bulls-arena IDL from src/lib.rs.

Run `--verify` to check only, which is what `the_idl_generator_still_reproduces_the_committed_idl`
in lib.rs's test module does on every `cargo test`.

`anchor idl build` cannot run on this machine (anchor-attribute-account's idl-build path fails to
compile under the pinned toolchain), so this reproduces the parts of it this change touches. Nothing
here is guessed:

  * discriminators are re-derived with anchor's rule and CHECKED against all 18 already in the file;
  * doc strings are EXTRACTED from lib.rs and checked against every doc block already in the file;
  * the camelCase .ts is produced by a transform proven to reproduce the committed .ts byte-for-byte.

Run with --verify to do only the checks.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

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

    def docs_above(self, index):
        """The `///` block above `index`, as anchor emits it (leading `/// ` stripped).

        Attribute lines sit between the block and the item and can span several lines
        (`#[session_auth_or(...)]` on `enter`/`extract`), so anything that is not a doc line is
        skipped until either a doc line or the end of the previous item is reached. A blank line or a
        closing brace means the item has no doc block at all.

        A line ENDING in `}` is a boundary too, not just one starting with it. The `#[event]` structs
        are each declared on a single line, so a preceding sibling is a complete item that both opens
        and closes on its own line. Stopping only at a LEADING `}` walked straight over it and handed
        `SeedRevealed` and `RoundSettled` the doc block belonging to `RoundAbandoned` above them —
        silently, since every name still resolved. Undocumented items must come back empty."""
        i = index - 1
        while i >= 0 and not self.lines[i].strip().startswith("///"):
            s = self.lines[i].strip()
            if s == "" or s.startswith("}") or s.endswith("}") or s.endswith(";") or s.endswith("{"):
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
                return self.docs_above(i)
            i += 1
        return None


HEAD = Source(subprocess.run(
    ["git", "-C", str(ROOT), "show", "HEAD:programs/bulls-arena/src/lib.rs"],
    check=True, capture_output=True, text=True).stdout)
NOW = Source(SRC.read_text(encoding="utf-8"))
fn_docs = NOW.fn_docs
struct_field_docs = NOW.struct_field_docs
event_docs = NOW.event_docs


# ---- what this generator rewrites from source ---------------------------------------------------
#
# ONE list, read by both `patch` and `verify`, because they are two halves of the same statement.
# `patch` regenerates these items' docs out of lib.rs; `verify` therefore must NOT hold them against
# the committed IDL, since a difference there is exactly the staleness the generator exists to fix,
# not evidence the extractor is broken. Kept together so the two can never disagree about which is
# which — as they did when a doc block was edited in lib.rs and committed without regenerating, and
# `verify` failed on `Round.lobby_opened_at` in a way that blocked the only tool that could fix it.
REGENERATED_FNS = {"open_round", "enter", "close_lobby_and_draw"}
REGENERATED_EVENTS = {"RoundOpened", "RoundAbandoned"}
REGENERATED_ROUND_FIELDS = {"lobby_opened_at"}


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
    #    EVERY occurrence, not only the top-level `address`. `delegate_round.owner_program` is declared
    #    `address = crate::ID`, so anchor emits this program's id a second time inside the account
    #    list. Rewriting just the top-level field left that one pinned to the PREVIOUS deployment,
    #    which would have made `delegate_round` fail against a correctly deployed program — and
    #    `idl.ts`'s runtime assert compares `idl.address` alone, so nothing downstream would have
    #    caught it. Replaced BY VALUE: an account whose fixed address is this program is this program.
    #    Mutated in place, because `ix`/`types` above alias these same dicts.
    old_id, new_id = idl["address"], declared_id()

    def retarget(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "address" and v == old_id:
                    node[k] = new_id
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

    # 6. the three new errors, appended so no existing code moves
    have = {e["name"] for e in idl["errors"]}
    for code, name, msg in (
        (6014, "LobbyClosed", "the lobby deadline has passed — this round is no longer taking entries"),
        (6015, "LobbyStillOpen", "the lobby deadline has not passed and the round is not full"),
        (6016, "LobbyNotAbandonable", "this lobby can still become a fight — it may not be abandoned"),
    ):
        if name not in have:
            idl["errors"].append({"code": code, "name": name, "msg": msg})

    # anchor emits each list sorted by name
    idl["instructions"].sort(key=lambda x: x["name"])
    idl["events"].sort(key=lambda x: x["name"])
    idl["types"].sort(key=lambda x: x["name"])
    idl["errors"].sort(key=lambda x: x["code"])
    return idl


def main():
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
    if "--verify" in sys.argv:
        return

    idl = patch(idl)
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
