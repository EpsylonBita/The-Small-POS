//! Local IP Helper tables only: no script, socket, DNS or remote request.
use serde_json::{json, Value};

pub(super) fn collect(
    target: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    check()?;
    let facts = local_tables(check);
    check()?;
    Ok(project(target, facts))
}

fn project(target: &str, facts: Result<(&str, bool), String>) -> Value {
    let (state, connectivity, route) = match facts {
        Ok((kind, present)) => ("unknown", kind, json!(present)),
        Err(_) => ("unavailable", "none", json!("unknown")),
    };
    // Sync retains last successful pass time, not an API reachability verdict.
    // Neither a pass time nor cached availability is a reachability observation.

    let mut detail = json!({"target":target,"state":state,"evidence":"local_only","observed_age_ms":0,
        "connectivity_type":connectivity,"route_present":route,"retained_api_observation":{"state":"unavailable","unavailable_reason":"live_check_on_site"}});
    if state == "unavailable" {
        detail["unavailable_reason"] = json!("read_failed");
    }
    detail
}

#[cfg(test)]
#[test]
fn failed_local_tables_and_missing_reachability_are_never_healthy() {
    let failed = project("api", Err("your-secret-os-error".into()));
    assert_eq!(failed["state"], "unavailable");
    assert_eq!(failed["route_present"], "unknown");
    assert!(!failed.to_string().contains("your-secret"));
    let local = project("api", Ok(("ethernet", true)));
    assert_eq!(local["state"], "unknown");
    assert_eq!(local["retained_api_observation"]["state"], "unavailable");
}

#[cfg(windows)]
fn local_tables(check: &dyn Fn() -> Result<(), String>) -> Result<(&'static str, bool), String> {
    use windows::Win32::{
        NetworkManagement::IpHelper::{
            FreeMibTable, GetIfTable2, GetIpForwardTable2, MIB_IF_TABLE2, MIB_IPFORWARD_TABLE2,
        },
        Networking::WinSock::AF_UNSPEC,
    };
    struct Table(*const core::ffi::c_void);
    impl Drop for Table {
        fn drop(&mut self) {
            unsafe { FreeMibTable(self.0) };
        }
    }
    let mut interfaces: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    // IP Helper allocates and fills local tables synchronously. No network I/O.
    unsafe { GetIfTable2(&mut interfaces) }
        .ok()
        .map_err(|_| "unavailable")?;
    if interfaces.is_null() {
        return Err("unavailable".into());
    }
    let _interfaces = Table(interfaces.cast());
    check()?;
    let mut routes: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
    unsafe { GetIpForwardTable2(AF_UNSPEC, &mut routes) }
        .ok()
        .map_err(|_| "unavailable")?;
    if routes.is_null() {
        return Err("unavailable".into());
    }
    let _routes = Table(routes.cast());
    check()?;
    // Flexible arrays are owned by the successful API results above and stay
    // alive until both RAII table guards drop. Never export names or addresses.
    let ifs = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!((*interfaces).Table).cast(),
            (*interfaces).NumEntries as usize,
        )
    };
    let routes = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!((*routes).Table).cast(),
            (*routes).NumEntries as usize,
        )
    };
    let ifs: &[windows::Win32::NetworkManagement::IpHelper::MIB_IF_ROW2] = ifs;
    let routes: &[windows::Win32::NetworkManagement::IpHelper::MIB_IPFORWARD_ROW2] = routes;
    let default = routes
        .iter()
        .filter(|r| r.DestinationPrefix.PrefixLength == 0 && !r.Loopback)
        .filter_map(|r| {
            ifs.iter()
                .find(|i| i.InterfaceIndex == r.InterfaceIndex && i.OperStatus.0 == 1)
                .map(|i| (r.Metric, i))
        })
        .min_by_key(|(metric, _)| *metric);
    let kind = |typ| match typ {
        71 => "wifi",
        6 => "ethernet",
        243 | 244 => "cellular",
        _ => "other",
    };
    Ok(if let Some((_, interface)) = default {
        (kind(interface.Type), true)
    } else {
        (
            ifs.iter()
                .find(|i| i.OperStatus.0 == 1 && i.Type != 24)
                .map(|i| kind(i.Type))
                .unwrap_or("none"),
            false,
        )
    })
}
#[cfg(not(windows))]
fn local_tables(_: &dyn Fn() -> Result<(), String>) -> Result<(&'static str, bool), String> {
    Err("unavailable".into())
}
