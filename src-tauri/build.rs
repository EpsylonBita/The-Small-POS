use std::process::Command;

fn main() {
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
