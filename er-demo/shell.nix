# er-demo development shell
#
# This shell provides Node.js and bun for the Vite/React devnet demo. No Playwright — there is no
# E2E suite in this project (manual run-through is the test plan; see the approved plan doc), so
# the browser-download machinery the svelte template carries for that has been dropped entirely.
#
# Usage:
# - With direnv: just `cd` into the directory (after `direnv allow`)
# - Manual: `nix-shell` then `bun install`
#
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    # Runtime - Node.js LTS for compatibility
    nodejs_22

    # Package manager - bun for speed
    bun

    # Command runner
    just

    # Development utilities
    jq  # JSON manipulation
  ];

  shellHook = ''
    # Check if bun is ready
    if command -v bun &> /dev/null; then
      echo "er-demo development shell"
      echo "  Node.js: $(node --version)"
      echo "  bun: $(bun --version)"
      echo ""
      echo "Run 'bun install' to install dependencies"
      echo "Run 'just' to see available commands"
    fi
  '';
}
