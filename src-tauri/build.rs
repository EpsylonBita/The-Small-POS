use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::env;
use std::process::Command;

const DEV_CALLER_ID_VERIFIER_PINS: &str =
    include_str!("../config/caller-id-offline-lease-verifier.properties");

fn main() {
    validate_caller_id_offline_lease_pins();
    tauri_build::build();

    // Embed build timestamp (UTC ISO-8601)
    let now = chrono_lite_utc_now();
    println!("cargo:rustc-env=BUILD_TIMESTAMP={now}");

    // Embed git SHA (short) if available
    let git_sha = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=BUILD_GIT_SHA={git_sha}");

    // Rebuild when git HEAD changes
    println!("cargo:rerun-if-changed=../.git/HEAD");
}

/// Caller ID offline activation is verified with a public Ed25519 key that is
/// pinned into the desktop binary at compile time. A release without those
/// pins would install successfully but fail every signed activation response,
/// so release builds must stop before packaging instead of shipping a broken
/// listener. Dev/debug builds use the checked-in public trust anchor when the
/// environment is absent; the corresponding private key never enters a POS
/// build or this repository.
fn validate_caller_id_offline_lease_pins() {
    const PUBLIC_KEY_ENV: &str = "CALLER_ID_OFFLINE_LEASE_PUBLIC_KEY";
    const KEY_ID_ENV: &str = "CALLER_ID_OFFLINE_LEASE_KEY_ID";

    println!("cargo:rerun-if-env-changed={PUBLIC_KEY_ENV}");
    println!("cargo:rerun-if-env-changed={KEY_ID_ENV}");
    println!("cargo:rerun-if-changed=../config/caller-id-offline-lease-verifier.properties");

    let release = env::var("PROFILE").ok().as_deref() == Some("release");

    let public_key = env::var(PUBLIC_KEY_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| (!release).then(|| dev_caller_id_verifier_pin(PUBLIC_KEY_ENV)))
        .unwrap_or_else(|| panic!("release build requires {PUBLIC_KEY_ENV}"));
    let decoded_public_key = URL_SAFE_NO_PAD
        .decode(&public_key)
        .unwrap_or_else(|_| panic!("{PUBLIC_KEY_ENV} must be valid unpadded base64url"));
    if decoded_public_key.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded_public_key) != public_key {
        panic!(
            "{PUBLIC_KEY_ENV} must be the unpadded base64url encoding of exactly 32 Ed25519 public-key bytes"
        );
    }

    let key_id = env::var(KEY_ID_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| (!release).then(|| dev_caller_id_verifier_pin(KEY_ID_ENV)))
        .unwrap_or_else(|| panic!("release build requires {KEY_ID_ENV}"));
    if key_id.is_empty()
        || key_id.len() > 80
        || !key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        panic!("{KEY_ID_ENV} must be 1-80 ASCII letters, digits, dots, underscores, or hyphens");
    }

    println!("cargo:rustc-env={PUBLIC_KEY_ENV}={public_key}");
    println!("cargo:rustc-env={KEY_ID_ENV}={key_id}");
}

fn dev_caller_id_verifier_pin(name: &str) -> String {
    DEV_CALLER_ID_VERIFIER_PINS
        .lines()
        .filter_map(|line| line.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.trim().to_string()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("dev Caller ID verifier pin {name} is missing"))
}

/// Minimal UTC timestamp without pulling in chrono at build time.
fn chrono_lite_utc_now() -> String {
    Command::new("date")
        .args(["+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            // Windows fallback: powershell
            Command::new("powershell")
                .args([
                    "-Command",
                    "(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
                ])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "unknown".into())
}
