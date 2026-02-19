#!/usr/bin/env bash
# verify-rust.sh — Rust build gate for The Small POS (Tauri)
#
# Runs: cargo fmt --check, cargo clippy, cargo test
# Exit 0 = all green, non-zero = gate failed
#
# Usage:
#   ./scripts/verify-rust.sh           # from pos-tauri/
#   bash pos-tauri/scripts/verify-rust.sh  # from repo root

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/../src-tauri" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo "=== Rust Build Gate ==="
echo "Working dir: $TAURI_DIR"
echo ""

# Pre-flight: check toolchain
if ! command -v cargo &>/dev/null; then
  fail "cargo not found. Install Rust: https://rustup.rs"
fi
if ! command -v rustfmt &>/dev/null; then
  warn "rustfmt not found, installing via rustup..."
  rustup component add rustfmt || fail "Could not install rustfmt"
fi
if ! command -v cargo-clippy &>/dev/null; then
  warn "clippy not found, installing via rustup..."
  rustup component add clippy || fail "Could not install clippy"
fi

echo "Rust: $(rustc --version)"
echo "Cargo: $(cargo --version)"
echo ""

cd "$TAURI_DIR"

# Step 1: fmt
echo "--- Step 1/3: cargo fmt --check ---"
if cargo fmt --check; then
  ok "Formatting is correct"
else
  fail "cargo fmt --check failed. Run 'cargo fmt' to fix."
fi

echo ""

# Step 2: clippy
echo "--- Step 2/3: cargo clippy ---"
if cargo clippy -- -D warnings; then
  ok "No clippy warnings"
else
  fail "cargo clippy found warnings (treated as errors)"
fi

echo ""

# Step 3: tests
echo "--- Step 3/3: cargo test ---"
if cargo test; then
  ok "All tests passed"
else
  fail "cargo test failed"
fi

echo ""
echo -e "${GREEN}=== Rust Build Gate PASSED ===${NC}"
