# REPRODUCIBLE BUILD OF programs/bulls-arena — the toolchain pinned in an image instead of assumed
# on a laptop.
#
#   docker compose run --rm program-build          # build the .so + IDL into target/docker/
#   docker compose run --rm program-build verify   # build, then diff against the deployed bytecode
#
# WHY THIS EXISTS, AND IT IS NOT "because Docker is nice". Three separate things went wrong that a
# pinned image makes impossible:
#
#   1. THE HOST BUILD DEPENDS ON WHATEVER IS INSTALLED. There is no rust-toolchain.toml anywhere in
#      this repo, so `anchor build` compiles with whichever rustc is on PATH — 1.85.1 on the machine
#      this was written on, while the program's own test script says `cargo +1.89 test`. Two Rust
#      versions in one workflow, neither of them written down where the build can read it.
#   2. A STALENESS PROBE ONCE REPORTED FOUR ER VALIDATORS AS OUT OF DATE, AND THE PROBE WAS WRONG.
#      It compared them against a locally rebuilt .so. Rust builds are not byte-reproducible across
#      differing toolchains, so "local build != deployed bytecode" answered a question nobody asked.
#      COST-MODEL.md §7 records it. With the toolchain pinned, that comparison becomes meaningful,
#      which is what the `verify` mode below is for.
#   3. THE REPO-ROOT Anchor.toml IS A TRAP. It declares `bulls_vault` at a placeholder id that is not
#      a valid 32-byte pubkey, and `programs/vault` is not even a workspace member — so `anchor build`
#      at the root dies with `String is the wrong size`, which names neither the file nor the field.
#      The real config is programs/bulls-arena/Anchor.toml. This image builds from that directory and
#      cannot be run from the wrong one.
#
# PINNED, and every version here is the one this program is known to compile under. Cargo.toml pins
# `anchor-lang = "=1.0.2"` with an exact-equals for the reason its own comment gives — an unpinned
# range silently resolved 1.1.2, which migrated an API. The CLI must match the crate, so it is
# exact-equals here too.
FROM --platform=linux/amd64 rust:1.85.1-slim-bookworm

# --platform is deliberate. Apple Silicon runs this under emulation, slowly, and that is the point:
# the deployed artifact is x86_64 and a build that silently differed by host architecture would
# defeat the entire purpose of pinning anything.

ARG SOLANA_VERSION=v2.1.21
ARG ANCHOR_VERSION=1.0.2

# `build-essential` and `pkg-config` are needed by the proc-macro crates; `libudev-dev` by the
# Solana CLI's hardware-wallet support, which is unused here but is a hard link-time dependency.
# `curl`/`ca-certificates` fetch the Solana release. All are build-time only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libudev-dev libssl-dev curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# The Solana toolchain brings `cargo-build-sbf`, which is what actually produces the BPF object —
# `cargo build` alone cannot target SBF.
RUN sh -c "$(curl -sSfL https://release.anza.xyz/${SOLANA_VERSION}/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

# --locked so the CLI itself is built from its own lockfile rather than whatever the registry has
# resolved to today. Without it this line is a floating dependency pretending to be a pin.
RUN cargo install --git https://github.com/coral-xyz/anchor avm --locked \
    && avm install ${ANCHOR_VERSION} \
    && avm use ${ANCHOR_VERSION}
ENV PATH="/root/.avm/bin:${PATH}"

# The registry index is the slow half of a cold build and it does not change between source edits.
# Warming it here means an edit-rebuild cycle pays for compilation only. The compose file mounts
# named volumes over ~/.cargo/registry and target/ so that survives container restarts too.
WORKDIR /build
COPY programs/bulls-arena/Cargo.toml programs/bulls-arena/Cargo.toml
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p programs/bulls-arena/src \
    && echo "// placeholder for dependency warming" > programs/bulls-arena/src/lib.rs \
    && (cargo fetch --locked || cargo fetch || true) \
    && rm -rf programs/bulls-arena/src

COPY docker/program-build.sh /usr/local/bin/program-build
RUN chmod +x /usr/local/bin/program-build

# No default CMD argument: `program-build` with no arguments builds, and `verify` is opt-in. A
# default that reached the network would make `docker compose run` do something different depending
# on whether the machine happens to be online.
ENTRYPOINT ["/usr/local/bin/program-build"]
