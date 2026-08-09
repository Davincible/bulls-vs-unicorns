/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bulls_arena.json`.
 */
export type BullsArena = {
  "address": "8s3x42af7gcNXDCTNheDtteQxeBS2D1p9xuU8C5Jgfrt",
  "metadata": {
    "name": "bullsArena",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Bulls vs Unicorns — on-chain round state, executed on a MagicBlock Ephemeral Rollup (DEVNET ONLY)"
  },
  "instructions": [
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
        "chooses the seed at all."
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
                116,
                212,
                46,
                255,
                56,
                210,
                164,
                50,
                203,
                42,
                27,
                247,
                253,
                160,
                244,
                2,
                255,
                228,
                124,
                114,
                152,
                148,
                44,
                118,
                217,
                26,
                20,
                251,
                1,
                18,
                108,
                141
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
          "address": "8s3x42af7gcNXDCTNheDtteQxeBS2D1p9xuU8C5Jgfrt"
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
        "Open a round and publish the (now vestigial) seed commitment BEFORE anyone can enter.",
        "",
        "The ordering is the whole point: a commitment published after entries are known proves",
        "nothing. Kept for format compatibility even though the real seed now comes from the VRF",
        "oracle via `close_lobby_and_draw`/`callback_seed`, not from a value the operator chose here."
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
          }
        ]
      }
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
