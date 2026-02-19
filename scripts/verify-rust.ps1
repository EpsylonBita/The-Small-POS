# verify-rust.ps1 — Rust build gate for The Small POS (Tauri)
#
# Runs: cargo fmt --check, cargo clippy, cargo test
# Exit 0 = all green, non-zero = gate failed
#
# Usage:
#   .\scripts\verify-rust.ps1           # from pos-tauri\
#   powershell pos-tauri\scripts\verify-rust.ps1  # from repo root

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TauriDir  = Join-Path (Split-Path -Parent $ScriptDir) "src-tauri"

function Write-Pass($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }

Write-Host "=== Rust Build Gate ===" -ForegroundColor Cyan
Write-Host "Working dir: $TauriDir"
Write-Host ""

# Pre-flight: check toolchain
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Fail "cargo not found. Install Rust: https://rustup.rs"
}

# Check rustfmt
$fmtCheck = rustup component list 2>&1 | Select-String "rustfmt.*installed"
if (-not $fmtCheck) {
    Write-Warn "rustfmt not found, installing..."
    rustup component add rustfmt
    if ($LASTEXITCODE -ne 0) { Write-Fail "Could not install rustfmt" }
}

# Check clippy
$clippyCheck = rustup component list 2>&1 | Select-String "clippy.*installed"
if (-not $clippyCheck) {
    Write-Warn "clippy not found, installing..."
    rustup component add clippy
    if ($LASTEXITCODE -ne 0) { Write-Fail "Could not install clippy" }
}

Write-Host "Rust: $(rustc --version)"
Write-Host "Cargo: $(cargo --version)"
Write-Host ""

Push-Location $TauriDir
try {
    # Step 1: fmt
    Write-Host "--- Step 1/3: cargo fmt --check ---" -ForegroundColor Cyan
    cargo fmt --check
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "cargo fmt --check failed. Run 'cargo fmt' to fix."
    }
    Write-Pass "Formatting is correct"
    Write-Host ""

    # Step 2: clippy
    Write-Host "--- Step 2/3: cargo clippy ---" -ForegroundColor Cyan
    cargo clippy -- -D warnings
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "cargo clippy found warnings (treated as errors)"
    }
    Write-Pass "No clippy warnings"
    Write-Host ""

    # Step 3: tests
    Write-Host "--- Step 3/3: cargo test ---" -ForegroundColor Cyan
    cargo test
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "cargo test failed"
    }
    Write-Pass "All tests passed"
    Write-Host ""

    Write-Host "=== Rust Build Gate PASSED ===" -ForegroundColor Green
}
finally {
    Pop-Location
}
