# Phase 3 MVP Smoke Test
# Verifies the Rust backend compiles and all modules link correctly.

param(
    [switch]$Build  # Pass -Build to run a full build instead of just check
)

$ErrorActionPreference = "Stop"

Write-Host "=== Phase 3 MVP Smoke Test ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Verify Rust toolchain
Write-Host "[1/3] Checking Rust toolchain..." -ForegroundColor Yellow
try {
    $rustVersion = & rustc --version 2>&1
    Write-Host "  Rust: $rustVersion" -ForegroundColor Gray
} catch {
    Write-Host "  ERROR: Rust toolchain not found. Install from https://rustup.rs" -ForegroundColor Red
    exit 1
}

# Step 2: Compile check (or full build)
$srcTauri = Join-Path $PSScriptRoot ".." "src-tauri"
Push-Location $srcTauri

if ($Build) {
    Write-Host "[2/3] Building pos-tauri (cargo build)..." -ForegroundColor Yellow
    cargo build 2>&1
} else {
    Write-Host "[2/3] Checking pos-tauri (cargo check)..." -ForegroundColor Yellow
    cargo check 2>&1
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  BUILD FAILED" -ForegroundColor Red
    Pop-Location
    exit 1
}

Write-Host "  BUILD OK" -ForegroundColor Green
Pop-Location

# Step 3: Verify module files exist
Write-Host "[3/3] Verifying module files..." -ForegroundColor Yellow
$modules = @("storage.rs", "api.rs", "auth.rs", "db.rs", "menu.rs", "sync.rs", "lib.rs")
$srcDir = Join-Path $srcTauri "src"
$allPresent = $true

foreach ($mod in $modules) {
    $path = Join-Path $srcDir $mod
    if (Test-Path $path) {
        $size = (Get-Item $path).Length
        Write-Host "  OK  $mod ($size bytes)" -ForegroundColor Gray
    } else {
        Write-Host "  MISSING  $mod" -ForegroundColor Red
        $allPresent = $false
    }
}

if (-not $allPresent) {
    Write-Host ""
    Write-Host "  Some modules are missing!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Phase 3 MVP: All checks passed ===" -ForegroundColor Green
