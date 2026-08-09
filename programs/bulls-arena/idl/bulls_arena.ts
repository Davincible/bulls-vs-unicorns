/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bulls_arena.json`.
 */
export type BullsArena = {
  "address": "CchN3JPWta2uVxKhwScBQhtPG5gpsaRzf3RA4aPCDam2",
  "metadata": {
    "name": "bullsArena",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Bulls vs Unicorns — on-chain round state, executed on a MagicBlock Ephemeral Rollup (DEVNET ONLY)"
  },
  "instructions": [
    {
      "name": "abandonRound",
      "docs": [
        "THE WAY OUT FOR A LOBBY THAT DIED UNDER-SUBSCRIBED — the deadline's other half.",
        "",
        "Adding a deadline created a state that could not previously exist: a round past",
        "`lobby_closes_at` holding fewer than two fighters. It can never fight (`enter` refuses past the",
        "deadline, so `fighter_count` cannot rise, and `close_lobby_and_draw` needs two), so without",
        "this it would sit in `Lobby` forever — delegated to an ER validator, counted by every history",
        "query, showing a countdown that expired and never resolved into anything. This repo has two",
        "permanently-stuck rounds in its history already and treats \"a round can always reach a terminal",
        "state\" as a promise (see `FIGHT_TIMEOUT_SECONDS`); a deadline without this instruction would",
        "have quietly broken that promise for the one case it introduced.",
        "",
        "EXTENDING THE DEADLINE WAS THE OTHER OPTION, AND IT IS THE WRONG ONE. A lobby that reopens",
        "itself when nobody shows up is a countdown that can be moved, which is exactly the \"invented",
        "number\" this whole change exists to delete — a clock a client cannot trust to mean what it says",
        "is worse than no clock. `Abandoned` says the true thing plainly, and the UI can say it too.",
        "",
        "PERMISSIONLESS, for the same reason `tick` and `resolve` are: every precondition is chain",
        "truth (the phase, the deadline, the frozen count) and nothing about the outcome is chosen by",
        "the caller. A round whose operator has walked away must not need that operator to come back.",
        "",
        "WHAT THIS DOES NOT COVER, said plainly rather than left to be discovered: `Phase::Drawing`",
        "still has no exit. `close_lobby_and_draw` moves a round there and then depends on the VRF",
        "oracle to call `callback_seed`, which only the VRF program may call — so if the callback never",
        "lands (queue down, callback transaction fails, validator restart between request and delivery)",
        "the round sits in `Drawing` forever with no instruction any signer can send. That hole",
        "PREDATES the lobby deadline and this change narrows rather than widens the way in (reaching",
        "`Drawing` now requires the deadline as well as two fighters), so closing it is separate work,",
        "not a regression to fix here. The shape of the fix, for whoever picks it up: stamp the moment",
        "the draw was requested — `fight_started_at` is 0 until `callback_seed` overwrites it and is",
        "read nowhere outside `Phase::Fight`, so it costs no account bytes — and let `abandon_round`",
        "also accept a `Drawing` round whose oracle has been silent for longer than a measured timeout.",
        "An abandoned `Drawing` round is the same terminal state for the same reason: no seed, no",
        "fight, no winner, nothing custodied. A late callback then fails harmlessly on its own",
        "`Phase::Drawing` guard.",
        "",
        "NOTHING IS REFUNDED, BECAUSE NOTHING WAS TAKEN. This program custodies no balances at all (see",
        "the file header) — `enter` records a stake, it does not move one — so an abandoned round owes",
        "nobody anything on-chain. Any single fighter who entered is recorded in `fighters` exactly as",
        "they were, for the off-chain ledger to settle to zero against, and their `stake`/`hp` are",
        "untouched so the round still reads as what it was.",
        "",
        "ONE INSTRUCTION WHERE SETTLEMENT TAKES TWO (`resolve` then `close_round`). That split exists so",
        "a settled round's result is committed to the base layer while players are still watching it in",
        "the rollup, and undelegated separately afterwards. An abandoned round has no result to publish",
        "and nobody watching, so there is nothing to do between the two halves: it commits and",
        "undelegates in one call, and the keeper's recovery path is a single transaction."
      ],
      "discriminator": [
        38,
        71,
        227,
        16,
        69,
        115,
        171,
        164
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "callbackSeed",
      "docs": [
        "The oracle delivers the seed. `#[vrf_callback]` enforces that ONLY the VRF program can call",
        "this — without it, anyone could hand us a seed of their choosing and the whole scheme is",
        "theatre."
      ],
      "discriminator": [
        179,
        172,
        236,
        94,
        46,
        130,
        64,
        92
      ],
      "accounts": [
        {
          "name": "vrfProgramIdentity",
          "docs": [
            "Scoped VRF identity PDA, bound to this program. Its presence as a signer proves",
            "the callback was issued by the VRF program for this program."
          ],
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "randomness",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "closeLobbyAndDraw",
      "docs": [
        "Close the lobby and ASK THE ORACLE for the seed.",
        "",
        "WHY THE REQUEST HAPPENS HERE AND NOT AT open_round.",
        "",
        "The obvious design is to draw randomness when the round opens. It is wrong: the seed would",
        "then be readable on-chain while entries are still open, so anyone could replay the fight",
        "before deciding which side to back. The round would be decided before it was played.",
        "",
        "Requesting AFTER the lobby closes means nobody — operator included — knows the seed while",
        "anyone can still act on it.",
        "",
        "This also closes the one real weakness of the old commit-reveal. That scheme stopped the",
        "operator seeing the book before choosing a seed, but nothing stopped grinding candidate",
        "seeds offline against the EXPECTED lobby and committing to the most favourable one. With the",
        "house fielding most of the fighters, that was not theoretical. The operator no longer",
        "chooses the seed at all.",
        "",
        "IT NOW REFUSES BEFORE THE DEADLINE (or before the lobby is full — see `lobby_may_close`). The",
        "operator used to decide when a lobby ended, which made the end of a lobby an intention rather",
        "than a fact, and left the countdown a client wants to draw as a guess about that intention.",
        "With this guard the countdown is the rule: the transaction that ends the lobby cannot land",
        "early, so `lobby_closes_at` is the earliest instant a fight can possibly begin, verifiable by",
        "anyone against the account.",
        "",
        "THE `>= 2` GUARD BELOW IS NOW LOAD-BEARING RATHER THAN A FORMALITY. Before the deadline, an",
        "under-subscribed lobby could simply be left open until it filled. It cannot now — `enter`",
        "refuses past the deadline — so a lobby that reaches it holding fewer than two fighters is",
        "finished, and this instruction is the thing that must never pretend otherwise. `abandon_round`",
        "is where such a round goes; see `lobby_is_dead`."
      ],
      "discriminator": [
        204,
        120,
        228,
        18,
        126,
        198,
        72,
        76
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "oracleQueue",
          "writable": true
        },
        {
          "name": "programIdentity",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  101,
                  110,
                  116,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "vrfProgram",
          "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "clientSeed",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "closeRound",
      "docs": [
        "Final commit + hand the account back to the base layer."
      ],
      "discriminator": [
        149,
        14,
        81,
        88,
        230,
        226,
        234,
        37
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "delegateRound",
      "docs": [
        "Hand the round account to the ER validator. Base layer.",
        "",
        "After this the account is owned by the Delegation Program and only the ER validator may write",
        "it — which is also what tells the Magic Router to route this round's transactions to the ER.",
        "Routing follows account ownership, not client configuration."
      ],
      "discriminator": [
        4,
        60,
        37,
        224,
        19,
        130,
        106,
        111
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "arena"
          ]
        },
        {
          "name": "arena",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  114,
                  101,
                  110,
                  97
                ]
              }
            ]
          }
        },
        {
          "name": "bufferRoundPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "roundPda"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                172,
                149,
                133,
                215,
                92,
                35,
                117,
                209,
                60,
                18,
                175,
                4,
                21,
                31,
                72,
                229,
                206,
                54,
                84,
                219,
                75,
                123,
                188,
                184,
                224,
                190,
                19,
                200,
                92,
                52,
                143,
                173
              ]
            }
          }
        },
        {
          "name": "delegationRecordRoundPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "roundPda"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataRoundPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "roundPda"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "roundPda",
          "writable": true
        },
        {
          "name": "ownerProgram",
          "address": "CchN3JPWta2uVxKhwScBQhtPG5gpsaRzf3RA4aPCDam2"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roundNo",
          "type": "u64"
        }
      ]
    },
    {
      "name": "enter",
      "docs": [
        "Add a fighter. Runs in the ER once the round is delegated.",
        "",
        "`stake` is the GROSS amount; the fee is taken here so the on-chain arithmetic matches the",
        "engine's, where a stake is recorded net of the deploy fee.",
        "",
        "THE DEADLINE IS ENFORCED HERE, not only at the draw, and that is what makes the countdown on",
        "screen honest rather than advisory. If entries were still accepted past `lobby_closes_at` — as",
        "they would be if only `close_lobby_and_draw` checked it — then \"entries close in 0:07\" would",
        "mean \"the operator MAY close in 0:07\", the button would keep working after zero, and the",
        "number would be back to describing an intention instead of a rule. It also fixes the lineup at",
        "a knowable instant: `fighter_count` stops moving at the deadline, and the fight's pace and",
        "penalty horizon are both functions of it.",
        "",
        "The cost of saying it here is one `Clock::get()` on the round's hottest instruction, which is",
        "a sysvar read of a value the runtime already has — the same call `tick`, `extract` and",
        "`resolve` each already make.",
        "",
        "SESSION KEYS (Phase 6). `#[session_auth_or]` runs BEFORE the body below: if `session_token`",
        "is present and valid (a real PDA, unexpired, bound to this program as `target_program` and",
        "to `player` as its `authority`), the transaction may be signed by the session key instead of",
        "`player`'s own wallet. With no session token supplied, it falls back to requiring",
        "`signer.key() == player.key()` — ordinary direct-wallet signing, byte-for-byte what this",
        "instruction did before this phase. Either way `who = ctx.accounts.player.key()` below is",
        "what actually gets credited; the session key/signer is never itself the fighter identity."
      ],
      "discriminator": [
        139,
        49,
        209,
        114,
        88,
        91,
        77,
        134
      ],
      "accounts": [
        {
          "name": "arena",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  114,
                  101,
                  110,
                  97
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "player",
          "docs": [
            "why this is intentionally not required to sign directly."
          ]
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        }
      ],
      "args": [
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "stake",
          "type": "u64"
        }
      ]
    },
    {
      "name": "extract",
      "docs": [
        "EXTRACT — the mechanic that makes the rollup load-bearing.",
        "",
        "A player pulls out mid-fight: whatever they are still holding in the ring is banked, and they",
        "stop being a target. This is the whole reason this game belongs on an ER.",
        "",
        "Without it the fight is a pure function of (seed, entries) — decided before it starts, with",
        "the 40 seconds of animation merely replaying a result that already exists. Nothing",
        "precomputed needs 10ms blocks, so the rollup would be decoration.",
        "",
        "With it, the outcome depends on WHEN humans press a button. State mutates constantly from",
        "many wallets mid-round, the result cannot be computed in advance, and latency stops being a",
        "performance note and becomes the game: at 400ms base-layer slots \"extract now\" is a promise",
        "you cannot keep.",
        "",
        "IT BANKS WHAT REMAINS, AND ONLY NOW DOES THAT MEAN ANYTHING. The code here is almost unchanged",
        "— it always banked `f.hp` — but until the fight actually advanced on-chain, `f.hp` was still",
        "the full entry stake at every moment of the Fight phase, so this paid out 100% no matter when",
        "it was pressed. Verified empirically before the change: hp=499000 -> banked=499000. The",
        "mechanic was decoration. With `tick`/`catch_up` moving `hp` for real, pulling out late banks",
        "less than pulling out early, which is the entire decision the round is built around.",
        "",
        "THE ONE REAL CHANGE IS THE `catch_up` BELOW, and it is not optional. Banking `f.hp` at the",
        "STORED cursor would mean the payout depends on whether anyone happened to tick recently — so a",
        "player could simply not tick, hope nobody else did, and extract at a cursor where they still",
        "held everything. That is the free-refund bug wearing a different hat. Settling the ring to the",
        "current time first makes the payout a function of the clock, not of anyone's diligence.",
        "",
        "The cost of that is bounded, not unbounded: `catch_up` can never run more than `MAX_STEPS`",
        "steps (see `canonical_cursor`), the same ceiling `resolve` is measured against. In the normal",
        "case — anything at all ticking — it runs single digits, and this stays the cheap instruction it",
        "needs to be. Clients should still request the CU ceiling on it, because the bound that makes",
        "this safe is a worst case, not a typical one.",
        "",
        "IT IS NOT FREE, AND IT IS CHEAPEST LAST. What leaves the ring is split: the fighter keeps most",
        "of it, the house takes `extract_penalty_bps(fighter_count, cursor)` — 20% at the opening bell,",
        "decaying linearly to nothing by the time the fight would normally be over. See",
        "`EXTRACT_PENALTY_START_BPS` for why the penalty exists at all (without it, \"enter, let one tick",
        "land, leave\" was a near-riskless option priced at nothing) and `PENALTY_HORIZON_STEPS` for why",
        "it decays against the CURSOR and over a per-lineup horizon.",
        "",
        "NO EXEMPTIONS, INCLUDING THE LAST FIGHTER STANDING — and that is a decision, not an omission.",
        "The tempting special case is \"don't charge someone whose opponents are all gone, they aren't",
        "escaping any risk\". It is unnecessary, because such a player is not being made to pay anything:",
        "once `fight_is_over`, nothing can touch their `hp` again, and `settle_sides` counts `hp` and",
        "`banked` identically — so standing still until `resolve` gives them the same value for free,",
        "and extracting is simply a button they have no reason to press. Adding the exemption would",
        "instead create a reason to ENGINEER that state (a wallet holding both sides can retire one to",
        "make the other's exit free), and would make the rate un-derivable from the cursor alone, which",
        "is the property that lets anyone re-check the penalty from the `Extracted` event.",
        "",
        "The penalty ROUNDING TO ZERO is likewise left alone. Integer division floors, so a fighter with",
        "a small enough remainder late enough in the fight pays nothing at all. That is the curve",
        "arriving where it was always going, one step early, on an amount too small for the difference",
        "to be worth a branch.",
        "",
        "SESSION KEYS (Phase 6). Same `player`/`signer` split and the same `#[session_auth_or]` guard",
        "as `enter` — see `Enter`'s struct doc comment for the full rationale. This is the more",
        "important of the two to cover: without it, every single extract — the one action this whole",
        "migration exists to make load-bearing — pops a wallet dialog under real time pressure."
      ],
      "discriminator": [
        39,
        1,
        91,
        107,
        190,
        175,
        160,
        48
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "player",
          "docs": [
            "intentionally not required to sign directly. Nobody extracts on anyone else's behalf: the",
            "`#[session_auth_or]` guard on `extract()` still requires either `signer == player` directly,",
            "or a session token whose `authority` is this exact pubkey."
          ]
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "initArena",
      "docs": [
        "One-time arena config. Base layer; never delegated — everything reads it."
      ],
      "discriminator": [
        24,
        246,
        252,
        176,
        155,
        175,
        123,
        124
      ],
      "accounts": [
        {
          "name": "arena",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  114,
                  101,
                  110,
                  97
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "tokenA",
          "type": "pubkey"
        },
        {
          "name": "tokenB",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "openRound",
      "docs": [
        "Open a round, publish the (now vestigial) seed commitment BEFORE anyone can enter, and STAMP",
        "THE DEADLINE the lobby closes at.",
        "",
        "The commitment's ordering is the whole point: a commitment published after entries are known",
        "proves nothing. Kept for format compatibility even though the real seed now comes from the VRF",
        "oracle via `close_lobby_and_draw`/`callback_seed`, not from a value the operator chose here.",
        "",
        "`lobby_seconds` is a DURATION, not an absolute deadline, and that is the whole reason the",
        "countdown can be trusted. An absolute `lobby_closes_at` supplied by the caller would be a",
        "number relative to the caller's own clock, written into an account that everything else reads",
        "against the chain's — so the operator's laptop being 40 seconds fast would silently shorten",
        "every lobby, and nobody reading the round could tell. Taking a duration means the chain stamps",
        "both ends itself and the only clock involved is the one the guards use."
      ],
      "discriminator": [
        66,
        235,
        123,
        240,
        8,
        35,
        185,
        159
      ],
      "accounts": [
        {
          "name": "arena",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  114,
                  101,
                  110,
                  97
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "arena"
              },
              {
                "kind": "arg",
                "path": "roundNo"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "arena"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roundNo",
          "type": "u64"
        },
        {
          "name": "seedCommit",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "lobbySeconds",
          "type": "u32"
        }
      ]
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "baseAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                181,
                183,
                0,
                225,
                242,
                87,
                58,
                192,
                204,
                6,
                34,
                1,
                52,
                74,
                207,
                151,
                184,
                53,
                6,
                235,
                140,
                229,
                25,
                152,
                204,
                98,
                126,
                24,
                147,
                128,
                167,
                62
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "resolve",
      "docs": [
        "Finalise the round: bring the fight up to date, decide the winner from where it stands, settle,",
        "commit.",
        "",
        "IT NO LONGER RUNS THE FIGHT FROM SCRATCH — it runs whatever steps `tick` has not already done.",
        "That was a deliberate choice between two options, and the other one is a trap: \"require the",
        "fight to have been fully ticked before you may resolve\" would make settlement depend on",
        "somebody having done optional work, which is exactly how a round becomes permanently stuck.",
        "This repo already has two of those (task #15) and does not need a third failure mode. So",
        "`resolve` is self-sufficient: it can always finish the job alone, and ticking only ever makes",
        "it cheaper. In the fully-unticked worst case it does precisely what the old one-shot `resolve`",
        "did, against the same MAX_STEPS bound that was measured and devnet-verified for it.",
        "",
        "WHEN IT MAY BE CALLED: once the fight is genuinely over (one side has nobody standing), or once",
        "the bell has rung (`FIGHT_TIMEOUT_SECONDS`), whichever comes first — see that constant for why",
        "this replaced a flat 5-second floor, and why leaving the floor in place would have handed a",
        "permissionless caller the power to settle a live fight at the moment it favoured them.",
        "",
        "The catch-up runs BEFORE that check on purpose: a fight that ends inside the very steps this",
        "call is about to run is over, and should settle now rather than making someone call twice.",
        "",
        "PER-HIT DATA STILL DOES NOT BELONG ON-CHAIN. Every blow is recomputable from the seed by",
        "anyone; storing them is publishing our own homework at a cost per byte. Only the inputs",
        "(seed, entries), the CURSOR, and the outcome (winner, final holdings) are recorded — which is",
        "exactly the set a sceptic needs to check the result themselves."
      ],
      "discriminator": [
        246,
        150,
        236,
        206,
        108,
        63,
        58,
        10
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "tick",
      "docs": [
        "TICK — advance the live fight, on-chain, mid-round. THE instruction that makes the rollup",
        "load-bearing rather than described as such.",
        "",
        "WHY THIS EXISTS AGAIN, HAVING BEEN DELETED ONCE. ER-024's original `tick` was removed by",
        "ER-030/031 for a good reason: with no player input, the fight was a pure function of",
        "(seed, entries, steps), and splitting one computation across 125 confirmations bought nothing.",
        "That reasoning was correct AND its premise is now false. `extract` gives players a decision",
        "DURING the fight, and a decision can only be about state that exists — so the fight has to",
        "actually be somewhere when the button is pressed. `HACKATHON_ANGLE.md` predicted this exact",
        "reversal (\"Fight becomes stepped again — but for a real reason\"); this is it, not a drift back.",
        "",
        "The concrete bug it fixes: `run_fight` used to be called in ONE place, at the very end of",
        "`resolve`, so for the entire Fight phase every fighter's `hp` was still their full entry stake",
        "and `extract` therefore returned 100% of it whenever it was pressed. A free undo button, while",
        "the browser animated health draining that the chain did not believe in.",
        "",
        "PERMISSIONLESS, AND NOT LOOSELY SO. There is no authority check because there is nothing to",
        "protect: this call cannot advance the fight past `canonical_cursor()`, which is fixed by real",
        "elapsed time and the lobby-frozen fighter count. So the strongest thing any caller can do is",
        "make the stored state agree with the state that already, definitionally, holds — and calling",
        "it more often, in bigger chunks, from more wallets, or not at all, all produce the same fight.",
        "A caller who ticks aggressively is doing the round a favour at their own expense; a caller who",
        "refuses to tick achieves nothing, because `extract` and `resolve` catch up themselves.",
        "Front-running someone's `extract` with a tick is likewise no attack: it can only move the",
        "cursor to where the clock already says it is, which is precisely what that `extract` was about",
        "to do anyway.",
        "",
        "WHO DRIVES IT: whoever is watching. The browser client ticks once a second while it has a",
        "round in Fight phase (`er-demo/src/chain/useFightTicker.ts`) — every open tab, including",
        "spectators, using a session key so it costs no wallet dialogs. A keeper can do it too. Nobody",
        "HAS to: an unticked round is still settled correctly by `resolve`, just with the arithmetic",
        "deferred. That is the difference between a liveness helper and a dependency.",
        "",
        "`steps` is a hint, not a promise: the call runs `min(steps, cursor_backlog)` and succeeds",
        "having done nothing when the fight is already up to date. Deliberate — two clients ticking the",
        "same round must not make each other's transactions fail."
      ],
      "discriminator": [
        92,
        79,
        44,
        8,
        101,
        80,
        63,
        15
      ],
      "accounts": [
        {
          "name": "round",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "steps",
          "type": "u32"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "arena",
      "discriminator": [
        243,
        215,
        44,
        44,
        231,
        211,
        232,
        168
      ]
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    }
  ],
  "events": [
    {
      "name": "extracted",
      "discriminator": [
        39,
        93,
        179,
        61,
        60,
        155,
        22,
        54
      ]
    },
    {
      "name": "roundAbandoned",
      "discriminator": [
        244,
        100,
        135,
        140,
        189,
        183,
        198,
        3
      ]
    },
    {
      "name": "roundOpened",
      "discriminator": [
        99,
        173,
        228,
        72,
        142,
        57,
        109,
        178
      ]
    },
    {
      "name": "roundSettled",
      "discriminator": [
        249,
        225,
        66,
        54,
        157,
        200,
        234,
        222
      ]
    },
    {
      "name": "seedRevealed",
      "discriminator": [
        28,
        28,
        203,
        69,
        255,
        141,
        240,
        236
      ]
    },
    {
      "name": "ticked",
      "discriminator": [
        62,
        38,
        144,
        106,
        104,
        131,
        254,
        110
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "feeTooHigh",
      "msg": "fee exceeds the 10% ceiling"
    },
    {
      "code": 6001,
      "name": "roundOutOfOrder",
      "msg": "rounds must open in sequence"
    },
    {
      "code": 6002,
      "name": "notInLobby",
      "msg": "round is not in the lobby phase"
    },
    {
      "code": 6003,
      "name": "notFighting",
      "msg": "round is not fighting"
    },
    {
      "code": 6004,
      "name": "notSettled",
      "msg": "round has not settled"
    },
    {
      "code": 6005,
      "name": "badSide",
      "msg": "side must be 0 or 1"
    },
    {
      "code": 6006,
      "name": "zeroStake",
      "msg": "stake must be greater than zero"
    },
    {
      "code": 6007,
      "name": "roundFull",
      "msg": "round is full"
    },
    {
      "code": 6008,
      "name": "badStepCount",
      "msg": "step count out of range"
    },
    {
      "code": 6009,
      "name": "notDrawing",
      "msg": "round is not awaiting randomness"
    },
    {
      "code": 6010,
      "name": "notEnoughFighters",
      "msg": "a fight needs at least two fighters"
    },
    {
      "code": 6011,
      "name": "nothingToExtract",
      "msg": "nothing in the ring to extract"
    },
    {
      "code": 6012,
      "name": "mathOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6013,
      "name": "fightNotOverYet",
      "msg": "both sides still have fighters standing and the bell has not rung"
    },
    {
      "code": 6014,
      "name": "lobbyClosed",
      "msg": "the lobby deadline has passed — this round is no longer taking entries"
    },
    {
      "code": 6015,
      "name": "lobbyStillOpen",
      "msg": "the lobby deadline has not passed and the round is not full"
    },
    {
      "code": 6016,
      "name": "lobbyNotAbandonable",
      "msg": "this lobby can still become a fight — it may not be abandoned"
    }
  ],
  "types": [
    {
      "name": "arena",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "tokenA",
            "type": "pubkey"
          },
          {
            "name": "tokenB",
            "type": "pubkey"
          },
          {
            "name": "roundCounter",
            "type": "u64"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "extracted",
      "docs": [
        "`amount` is GROSS — everything that left the ring. Of that, `penalty` went to the house and the",
        "rest (`amount - penalty`) was added to the fighter's `banked`; a client showing \"you banked X,",
        "penalty Y\" wants exactly that subtraction. `cursor` is where the fight stood when the button",
        "landed, which is what makes the rate checkable from this event alone: it must equal",
        "`extract_penalty_bps(fighter_count, cursor)`, and `fighter_count` was frozen at lobby close."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "penalty",
            "type": "u64"
          },
          {
            "name": "cursor",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "fighter",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "dead",
            "type": "u8"
          },
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "hp",
            "type": "u64"
          },
          {
            "name": "banked",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "round",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "arena",
            "type": "pubkey"
          },
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "phase",
            "type": "u8"
          },
          {
            "name": "winner",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "fighterCount",
            "type": "u16"
          },
          {
            "name": "tickCount",
            "type": "u64"
          },
          {
            "name": "pot",
            "type": "u64"
          },
          {
            "name": "penaltiesCollected",
            "docs": [
              "THE LEAK, NAMED. Extract penalties taken out of this round for the house, cumulative.",
              "",
              "Until this field existed, every fighter's `hp + banked` summed to exactly `pot` forever, and",
              "this repo checks that in six places — the Rust tests, the TypeScript mirror's `totalValue`, the",
              "browser's `verifyRound`, and the devnet scripts. `extract` now moves value OUT of the round, so",
              "that identity is no longer true and the honest response is to record where the difference went",
              "rather than to weaken the check. Conservation becomes:",
              "",
              "```text",
              "sum(hp + banked) + penalties_collected == pot",
              "```",
              "",
              "— still exact, still provable from the account alone, and now it also proves the house took",
              "precisely what the published curve says it should. A silently-subtracted penalty would have",
              "been unauditable AND would have made every existing verifier report a false mismatch on any",
              "round where somebody extracted, which reads as an accusation of cheating rather than as a",
              "missing field.",
              "",
              "It is a RECORD, not custody: this program deliberately holds no balances (see the file header),",
              "so the treasury is paid off-chain from the ledger, and this is the number that settlement is",
              "owed against."
            ],
            "type": "u64"
          },
          {
            "name": "seedCommit",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lobbyOpenedAt",
            "docs": [
              "WHEN THE LOBBY OPENED, AND WHEN IT STOPS TAKING ENTRIES — the countdown, as chain truth.",
              "",
              "WHY THESE ARE ON THE ACCOUNT AT ALL. A lobby used to stay open until an operator chose to call",
              "`close_lobby_and_draw`, and the only timestamp a round carried was `fight_started_at` — which",
              "does not exist yet while the lobby is open. So a UI counting down to \"entries close in 0:12\"",
              "was counting down to a number it had invented, describing an intention the chain had never",
              "been told about. Every other figure this project puts on screen is re-derivable from the",
              "account by a sceptic; the countdown was the one that wasn't. Now `lobby_closes_at - now` is",
              "the number, `enter` refuses past it and `close_lobby_and_draw` refuses before it, so the clock",
              "on screen is the same clock the program is enforcing.",
              "",
              "BOTH ENDS, NOT JUST THE DEADLINE — the second timestamp earns its eight bytes twice:",
              "  * A progress bar needs the DURATION, not the remaining time. The off-chain original drew",
              "    exactly this bar (`web/index.html`: `roundbar.style.width = (1 - left/LMS) * 100 + \"%\"`),",
              "    and with only `lobby_closes_at` a client would have to supply `LMS` from a constant of its",
              "    own — the same invented number moved to a different file.",
              "  * It makes `open_round`'s clamp self-evident instead of taken on trust:",
              "    `lobby_closes_at - lobby_opened_at` IS the duration the chain used, so an operator who",
              "    passed nonsense sees the clamped value by reading the round, and anyone can check it lies",
              "    within [MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS] without going to find the opening",
              "    transaction's block time.",
              "",
              "STAMPED ON THE BASE LAYER, COMPARED IN THE ROLLUP, and this is the one assumption in the whole",
              "feature that has NOT been measured. `open_round` runs before `delegate_round`, so `Clock` here",
              "is the base layer's, while `enter`'s and `close_lobby_and_draw`'s comparisons against it happen",
              "in the ER against the ER's. This is the program's FIRST cross-domain time comparison —",
              "`fight_started_at` is stamped and read entirely inside the ER by design — so nothing in this",
              "repo has ever exercised it.",
              "",
              "Nothing else is derived from these two numbers, so a skew shifts the deadline by that skew and",
              "corrupts nothing. But THE TWO DIRECTIONS ARE NOT SYMMETRIC and only one of them is benign:",
              "  * ER clock BEHIND the base layer: the lobby simply lasts longer than asked. Harmless.",
              "  * ER clock AHEAD by more than the whole duration: the round opens ALREADY EXPIRED. Every",
              "    `enter` fails `LobbyClosed`, the lobby reaches its deadline at zero fighters, and the only",
              "    outcome is `abandon_round` — for every round, forever, reported as an error that names the",
              "    wrong cause. `MIN_LOBBY_SECONDS` (30) is the entire margin against this and was derived",
              "    from delegation latency and entry time with no term for clock skew, because there is no",
              "    measurement to put one on.",
              "",
              "WHAT WOULD SETTLE IT: read `Clock::unix_timestamp` from a base-layer instruction and from an ER",
              "instruction on the same round within a second, and record the offset here the way the pacing",
              "tables above are recorded. If it is not small, the fix is to move the stamp to the enforcing",
              "clock — store the duration at `open_round` and stamp both ends on the first ER-side instruction",
              "— so the two are the same clock, as they already are for `fight_started_at`."
            ],
            "type": "i64"
          },
          {
            "name": "lobbyClosesAt",
            "type": "i64"
          },
          {
            "name": "fightStartedAt",
            "docs": [
              "Unix timestamp `callback_seed` stamped when `Phase::Fight` began. `resolve` derives `steps`",
              "from elapsed real time against this — see the constants near `DUST` for why."
            ],
            "type": "i64"
          },
          {
            "name": "fighters",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "fighter"
                  }
                },
                16
              ]
            }
          }
        ]
      }
    },
    {
      "name": "roundAbandoned",
      "docs": [
        "A lobby that reached its deadline without enough fighters to hold a fight — see `abandon_round`.",
        "`fighter_count` is included because it is the whole story: 0 means nobody came, 1 means one wallet",
        "was left standing alone, and neither is a fight."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "fighterCount",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "roundOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "seedCommit",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lobbyOpenedAt",
            "type": "i64"
          },
          {
            "name": "lobbyClosesAt",
            "type": "i64"
          }
        ]
      },
      "docs": [
        "Carries the deadline as well as the commitment, so a listener that never fetches the account can",
        "still draw the same countdown — the log is the one place a client learns a round exists at all."
      ]
    },
    {
      "name": "roundSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "winner",
            "type": "u8"
          },
          {
            "name": "pot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "seedRevealed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "sessionToken",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "targetProgram",
            "type": "pubkey"
          },
          {
            "name": "sessionSigner",
            "type": "pubkey"
          },
          {
            "name": "validUntil",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ticked",
      "docs": [
        "`steps` is how many this call actually ran (0 when the fight was already up to date), `cursor` is",
        "where the fight now stands."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundNo",
            "type": "u64"
          },
          {
            "name": "cursor",
            "type": "u64"
          },
          {
            "name": "steps",
            "type": "u32"
          }
        ]
      }
    }
  ]
};

