/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bulls_arena.json`.
 */
export type BullsArena = {
  "address": "F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW",
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
                209,
                19,
                104,
                243,
                233,
                208,
                198,
                103,
                122,
                27,
                187,
                92,
                191,
                104,
                184,
                116,
                202,
                237,
                138,
                201,
                198,
                185,
                49,
                205,
                64,
                118,
                253,
                158,
                156,
                50,
                178,
                11
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
          "address": "F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW"
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
        "engine's, where a stake is recorded net of the deploy fee."
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
        "Deliberately cheap — one guard, one move of value, no loop. It has to be affordable to call",
        "at any moment by anyone, which is the opposite of the fight itself."
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
            "The player pulling out — must sign. Nobody extracts on anyone else's behalf."
          ],
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
        "Run the ENTIRE fight and settle it, in one instruction.",
        "",
        "This replaced a `tick(steps)` that had to be called ~125 times per round. That design was",
        "copying the off-chain engine's shape — which ticks in real time because it is DRAWING the",
        "fight — without asking whether the chain needed it. It did not. The fight is a pure function",
        "of (seed, entries, steps); splitting it across 125 round-trips does not make it more correct,",
        "it just spreads one computation over 125 confirmations.",
        "",
        "NOR DOES THE PER-HIT DATA BELONG ON-CHAIN. Every blow is recomputable from the seed by",
        "anyone; storing them is publishing our own homework at a cost per byte. Only the inputs",
        "(seed, entries) and the OUTCOME (winner, final holdings) are recorded — which is exactly the",
        "set a sceptic needs to check the result themselves.",
        "",
        "`steps` is DERIVED, not accepted as an argument — see the constants above for why. It is a",
        "pure function of how long `Phase::Fight` has genuinely been running, which nobody controls."
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
      "msg": "step count must be 1..=20000"
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
      "msg": "the fight must run for MIN_FIGHT_SECONDS before it can be resolved"
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
    }
  ]
};
