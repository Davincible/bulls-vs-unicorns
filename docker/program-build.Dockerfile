# REPRODUCIBLE BUILD OF programs/bulls-arena — the toolchain pinned in an image instead of assumed
# on a laptop.
#
#   docker compose run --rm program-build          # build the .so into target/docker/
#   docker compose run --rm program-build verify   # build, then diff against the deployed bytecode
#
# THE .so ONLY — no IDL. `scripts/idlgen.py` owns the IDL in this repo and verifies it separately,
# so the build calls `cargo-build-sbf` directly and never asks anchor to generate one. See
# docker/program-build.sh's header for why that stopped being a nicety: anchor's IDL step compiles
# the crate a SECOND time for the host target, and a failure there discards a perfectly good `.so`.
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
#   3. THE REPO-ROOT Anchor.toml WAS A TRAP, AND THIS IMAGE IS WHY IT ISN'T. It declared
#      `bulls_vault` at a placeholder id that is not a valid 32-byte pubkey, for a program that is
#      not a workspace member, so `anchor build` at the root died with `String is the wrong size` —
#      naming neither the file nor the field. That entry is gone, and the root Anchor.toml now
#      scopes `[workspace] members` to the one program this repo builds, because anchor's default is
#      to glob `programs/*` and walk into the dormant vault and the Phase 0 session spike as well.
#
# PINNED, and every version here is the one this program is known to compile under. Cargo.toml pins
# `anchor-lang = "=1.0.2"` with an exact-equals for the reason its own comment gives — an unpinned
# range silently resolved 1.1.2, which migrated an API. The CLI must match the crate, so it is
# exact-equals here too.
#
# WHICH RUST VERSION ACTUALLY DETERMINES THE ARTIFACT, because the obvious answer is wrong and this
# file was first written with the wrong one. The HOST rustc below does not compile the on-chain
# object. `cargo-build-sbf` carries its own Rust inside Solana's platform-tools and uses it for the
# SBF target; the host toolchain builds only proc-macros and build scripts, which do not end up in
# the `.so`. So **SOLANA_VERSION is the pin that governs reproducibility of the bytecode**, and the
# host rustc merely has to be new enough to compile the tooling.
#
# That is not a theory — it is why this image failed on its first build. It was pinned to 1.85.1 to
# match the laptop, and `avm` refused:
#
#     rustc 1.85.1 is not supported by the following packages:
#       cargo-platform@0.3.3 requires rustc 1.91
#       cargo_metadata@0.23.1 requires rustc 1.86.0
#
# Matching the host rustc bought nothing (it does not touch the artifact) and cost the build. So the
# host toolchain is now chosen to satisfy the tooling, and the reproducibility claim rests where it
# actually belongs.
FROM --platform=linux/amd64 rust:1.91-slim-bookworm

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
#
# --from-source ON `avm install`, AND IT IS LOAD-BEARING TWICE.
#
# The mechanical reason: by default `avm install` DOWNLOADS a prebuilt binary, and the 1.0.2 build is
# linked against a newer C library than this base image has. The failure is at exec time, not install
# time, so the image builds "successfully" and then every `anchor` invocation dies with:
#
#     /root/.avm/bin/anchor-1.0.2: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found
#
# Bookworm ships 2.36. Moving to a trixie base would also fix it (2.41) and was rejected, because it
# fixes this one binary's requirement rather than the class — the next pinned version can want
# something newer again, and the symptom would return in a form that looks like a different problem.
#
# The better reason: this image exists so that the bytecode it emits can be attributed to a known
# toolchain. A downloaded binary is an artifact nobody here built, from a chain nobody here checked,
# sitting in the middle of that attribution. Compiling it means the compiler is the one pinned above
# and the link is against this image's own libc, whatever the base later becomes.
#
# The cost is real and worth stating: this is the slow layer, several minutes under emulation. It
# caches, so it is paid once per Dockerfile edit rather than once per build.
RUN cargo install --git https://github.com/coral-xyz/anchor avm --locked \
    && avm install ${ANCHOR_VERSION} --from-source \
    && avm use ${ANCHOR_VERSION}
ENV PATH="/root/.avm/bin:${PATH}"

# The registry index is the slow half of a cold build and it does not change between source edits.
# Warming it here means an edit-rebuild cycle pays for compilation only. The compose file mounts
# named volumes over ~/.cargo/registry and target/ so that survives container restarts too.
#
# EVERY WORKSPACE MEMBER'S MANIFEST HAS TO BE LISTED HERE, and that coupling is the price of the
# trick rather than an oversight. Cargo resolves one graph across all members, so it refuses to read
# a workspace whose members are not on disk. Copying whole source trees instead would work and would
# also defeat the point — any source edit would bust this layer, which is exactly what it exists to
# avoid. So: manifests only, one line per member of `[workspace] members` in the root Cargo.toml,
# and it must be updated when that list is. `crates/arena-state` is here because it joined that list.
WORKDIR /build
COPY programs/bulls-arena/Cargo.toml programs/bulls-arena/Cargo.toml
COPY crates/arena-state/Cargo.toml crates/arena-state/Cargo.toml
COPY Cargo.toml Cargo.lock* ./
# `|| true` KEPT, and it is not hiding a broken fetch. This layer is an optimisation whose failure
# costs time and nothing else — the real build re-fetches whatever is missing. Letting a cold
# registry or a momentarily unresolvable graph fail the whole IMAGE would trade a slow build for no
# build. What it must not do is silently skip when it could have succeeded, which is why the member
# list above is maintained rather than left to `|| true` to paper over.
RUN mkdir -p programs/bulls-arena/src crates/arena-state/src \
    && echo "// placeholder for dependency warming" > programs/bulls-arena/src/lib.rs \
    && echo "// placeholder for dependency warming" > crates/arena-state/src/lib.rs \
    && (cargo fetch --locked || cargo fetch || true) \
    && rm -rf programs/bulls-arena/src crates/arena-state/src

COPY docker/program-build.sh /usr/local/bin/program-build
RUN chmod +x /usr/local/bin/program-build

# No default CMD argument: `program-build` with no arguments builds, and `verify` is opt-in. A
# default that reached the network would make `docker compose run` do something different depending
# on whether the machine happens to be online.
ENTRYPOINT ["/usr/local/bin/program-build"]
