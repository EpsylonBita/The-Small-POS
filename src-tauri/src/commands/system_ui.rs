use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::info;

use crate::db;

const MAX_CLIPBOARD_TEXT_LEN: usize = 1_000_000;
const DISPLAY_WINDOW_PREFIX: &str = "external-display";
const WINDOW_ZOOM_DEFAULT: f64 = 1.0;
const WINDOW_ZOOM_STEP: f64 = 0.1;
const WINDOW_ZOOM_MIN: f64 = 0.5;
const WINDOW_ZOOM_MAX: f64 = 2.0;

static WINDOW_ZOOM_LEVELS: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum SystemSettingsSection {
    Display,
    Sound,
    Touch,
    Power,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemSettingsRequest {
    section: SystemSettingsSection,
}

fn parse_system_settings_payload(arg0: Option<Value>) -> Result<SystemSettingsSection, String> {
    let payload = arg0.ok_or_else(|| "Missing system settings section".to_string())?;
    serde_json::from_value::<SystemSettingsRequest>(payload)
        .map(|request| request.section)
        .map_err(|_| {
            "Unsupported system settings section; use display, sound, touch, or power".to_string()
        })
}

// Documented Windows settings pages, never a caller-provided URI or command:
// https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings
fn system_settings_uri(section: SystemSettingsSection) -> &'static str {
    match section {
        SystemSettingsSection::Display => "ms-settings:display",
        SystemSettingsSection::Sound => "ms-settings:sound",
        SystemSettingsSection::Touch => "ms-settings:easeofaccess-mousepointer",
        SystemSettingsSection::Power => "ms-settings:powersleep",
    }
}

#[cfg(windows)]
fn launch_system_settings(uri: &'static str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let target: Vec<u16> = uri.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if result <= 32 {
        Err(format!(
            "Could not open Windows settings (system error {result})"
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn launch_system_settings(_uri: &'static str) -> Result<(), String> {
    Err("Opening system settings is supported only on Windows".to_string())
}

#[tauri::command]
pub async fn system_open_settings(arg0: Option<Value>) -> Result<Value, String> {
    let section = parse_system_settings_payload(arg0)?;
    launch_system_settings(system_settings_uri(section))?;
    Ok(serde_json::json!({ "success": true, "section": section }))
}

fn window_zoom_levels() -> &'static Mutex<HashMap<String, f64>> {
    WINDOW_ZOOM_LEVELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn value_to_text(value: Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn parse_clipboard_text_payload(arg0: Option<Value>) -> Result<String, String> {
    let text = match arg0 {
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            crate::value_str(&payload, &["text", "value", "content"]).unwrap_or_default()
        }
        Some(v) => value_to_text(v).unwrap_or_default(),
        None => String::new(),
    };

    if text.len() > MAX_CLIPBOARD_TEXT_LEN {
        return Err(format!(
            "Clipboard payload too large (max {} bytes)",
            MAX_CLIPBOARD_TEXT_LEN
        ));
    }
    Ok(text)
}

fn parse_notification_payload(arg0: Option<Value>) -> (String, String) {
    match arg0 {
        Some(Value::String(message)) => ("The Small POS".to_string(), message),
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            let title = crate::value_str(&payload, &["title"])
                .unwrap_or_else(|| "The Small POS".to_string());
            let body = crate::value_str(&payload, &["body", "message", "text"]).unwrap_or_default();
            (title, body)
        }
        _ => ("The Small POS".to_string(), String::new()),
    }
}

fn current_window_state(window: &tauri::Window) -> Value {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    serde_json::json!({
        "isMaximized": is_maximized,
        "isFullScreen": is_fullscreen,
    })
}

fn parse_window_position_payload(arg0: Option<Value>) -> Result<(i32, i32), String> {
    let payload = arg0.ok_or_else(|| "Missing window position payload".to_string())?;
    let x = crate::value_i64(&payload, &["x", "left"])
        .ok_or_else(|| "Missing window x position".to_string())?;
    let y = crate::value_i64(&payload, &["y", "top"])
        .ok_or_else(|| "Missing window y position".to_string())?;

    Ok((
        x.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        y.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    ))
}

fn emit_window_state_changed(window: &tauri::Window) {
    let _ = window.emit("window_state_changed", current_window_state(window));
}

// `get_webview`, not `get_webview_window`: the main window also hosts the
// efood Partner child webview, so it is not a single-webview window.
fn current_webview(window: &tauri::Window) -> Result<tauri::Webview, String> {
    window
        .app_handle()
        .get_webview(window.label())
        .ok_or_else(|| format!("No webview found for label {}", window.label()))
}

fn current_zoom_scale(window: &tauri::Window) -> f64 {
    window_zoom_levels()
        .lock()
        .ok()
        .and_then(|levels| levels.get(window.label()).copied())
        .unwrap_or(WINDOW_ZOOM_DEFAULT)
}

fn set_window_zoom(window: &tauri::Window, scale: f64) -> Result<(), String> {
    let clamped = scale.clamp(WINDOW_ZOOM_MIN, WINDOW_ZOOM_MAX);
    let webview = current_webview(window)?;
    webview.set_zoom(clamped).map_err(|e| e.to_string())?;

    if let Ok(mut levels) = window_zoom_levels().lock() {
        levels.insert(window.label().to_string(), clamped);
    }

    Ok(())
}

fn display_content_type(arg0: Option<&Value>) -> String {
    let requested = arg0
        .and_then(|payload| {
            crate::value_str(
                payload,
                &[
                    "contentType",
                    "content_type",
                    "displayType",
                    "display_type",
                    "kind",
                ],
            )
        })
        .unwrap_or_else(|| "customer_display".to_string())
        .trim()
        .to_lowercase();

    match requested.as_str() {
        "kitchen_display" | "kds" | "kitchen" => "kitchen_display".to_string(),
        _ => "customer_display".to_string(),
    }
}

fn display_window_label(content_type: &str) -> String {
    format!("{}-{}", DISPLAY_WINDOW_PREFIX, content_type)
}

fn display_window_title(content_type: &str) -> &'static str {
    match content_type {
        "kitchen_display" => "Kitchen Display",
        _ => "Customer Display",
    }
}

fn display_window_url(content_type: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?externalDisplay={content_type}").into())
}

mod display_lease;

use display_lease::{
    CloseOutcome, DisplayLeases, DisplayRequest, Lease, LeaseError, LeasePhase, MonitorSlot,
    Reservation,
};

// Native screen ownership of the external display windows. Locked only briefly,
// never across a window build, placement or destroy call.
static DISPLAY_LEASES: Mutex<DisplayLeases> = Mutex::new(DisplayLeases::new());

fn display_leases() -> std::sync::MutexGuard<'static, DisplayLeases> {
    DISPLAY_LEASES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Handle of each built display window by lease instance. A label can already name
// a newer window, so destroy and liveness decisions use only this handle. Locked
// only briefly, never across a window call; taken handles are used after unlock.
static DISPLAY_WINDOWS: Mutex<Vec<(u64, tauri::WebviewWindow)>> = Mutex::new(Vec::new());

fn display_windows() -> std::sync::MutexGuard<'static, Vec<(u64, tauri::WebviewWindow)>> {
    DISPLAY_WINDOWS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_display_window(instance: u64, window: tauri::WebviewWindow) {
    display_windows().push((instance, window));
}

/// A clone of the handle of `instance`; the lock ends with this call.
fn display_window(instance: u64) -> Option<tauri::WebviewWindow> {
    display_windows()
        .iter()
        .find(|(held, _)| *held == instance)
        .map(|(_, window)| window.clone())
}

/// Takes the handle of `instance` out of the map; the caller uses or drops it
/// after the lock ends with this call.
fn take_display_window(instance: u64) -> Option<tauri::WebviewWindow> {
    let mut windows = display_windows();
    let index = windows.iter().position(|(held, _)| *held == instance)?;
    Some(windows.swap_remove(index).1)
}

fn monitor_id(monitor: &tauri::Monitor) -> String {
    let position = monitor.position();
    let size = monitor.size();
    display_lease::monitor_fingerprint(
        monitor.name().map(String::as_str).unwrap_or_default(),
        position.x,
        position.y,
        size.width,
        size.height,
        monitor.scale_factor(),
    )
}

/// Monitors connected now, read before any lease is locked. Only the monitor
/// showing the cashier window, or every monitor while that one is unknown, is
/// never an external target; the OS primary flag is informational.
struct ConnectedMonitors {
    monitors: Vec<tauri::Monitor>,
    slots: Vec<MonitorSlot>,
    primary_id: Option<String>,
    pos_id: Option<String>,
}

fn connected_monitors(app: &tauri::AppHandle) -> Result<ConnectedMonitors, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let primary_id = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_id(&monitor));
    // `get_window`: the main window can host more than one webview.
    let pos_id = app
        .get_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .map(|monitor| monitor_id(&monitor));
    let identities: Vec<(String, bool)> = monitors
        .iter()
        .map(|monitor| {
            let id = monitor_id(monitor);
            let position = monitor.position();
            // Without a native answer, the Windows primary monitor is the one at the origin.
            let is_primary = match &primary_id {
                Some(primary) => *primary == id,
                None => position.x == 0 && position.y == 0,
            };
            (id, is_primary)
        })
        .collect();
    // An unread cashier monitor, or one missing from this list, fails closed: no screen is external.
    let slots = display_lease::monitor_slots(identities, pos_id.as_deref());
    // Only a cashier monitor connected now is reported; an unknown one is none.
    let pos_id = pos_id.filter(|pos| slots.iter().any(|slot| slot.id == *pos));
    Ok(ConnectedMonitors {
        monitors,
        slots,
        primary_id,
        pos_id,
    })
}

fn monitor_to_json(
    index: usize,
    monitor: &tauri::Monitor,
    slot: &MonitorSlot,
    occupied_by: Option<&str>,
) -> Value {
    let size = monitor.size();
    let position = monitor.position();
    let work_area = monitor.work_area();
    let external = slot.is_external();
    serde_json::json!({
        "index": index,
        "id": slot.id,
        "name": monitor
            .name()
            .cloned()
            .unwrap_or_else(|| format!("Display {}", index + 1)),
        "scaleFactor": monitor.scale_factor(),
        "position": {
            "x": position.x,
            "y": position.y,
        },
        "size": {
            "width": size.width,
            "height": size.height,
        },
        "workArea": {
            "x": work_area.position.x,
            "y": work_area.position.y,
            "width": work_area.size.width,
            "height": work_area.size.height,
        },
        "isPrimary": slot.is_primary,
        "hostsPos": slot.hosts_pos,
        "external": external,
        "available": external && occupied_by.is_none(),
        "occupiedBy": occupied_by,
    })
}

fn presentations_json(leases: &[Lease]) -> Vec<Value> {
    leases
        .iter()
        .map(|lease| {
            serde_json::json!({
                "contentType": lease.content,
                "label": display_window_label(&lease.content),
                "displayId": lease.display_id,
                "token": lease.token,
                "state": lease.phase.as_str(),
            })
        })
        .collect()
}

fn capabilities_json(connected: &ConnectedMonitors, leases: &[Lease]) -> Value {
    let displays: Vec<Value> = connected
        .monitors
        .iter()
        .zip(&connected.slots)
        .enumerate()
        .map(|(index, (monitor, slot))| {
            let occupied_by = leases
                .iter()
                .find(|lease| lease.display_id == slot.id)
                .map(|lease| lease.content.as_str());
            monitor_to_json(index, monitor, slot, occupied_by)
        })
        .collect();
    let occupied: Vec<&str> = leases
        .iter()
        .map(|lease| lease.display_id.as_str())
        .collect();
    serde_json::json!({
        "success": true,
        "supported": true,
        "displays": displays,
        "primaryDisplayId": connected.primary_id,
        "posDisplayId": connected.pos_id,
        // Opening and closing windows still occupy their monitor.
        "occupiedDisplayIds": occupied,
        "activePresentations": presentations_json(leases),
    })
}

fn first_present<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| payload.get(*key).filter(|value| !value.is_null()))
}

/// Screen selector of an open request: an opaque `displayId` from the capability
/// list, a legacy index validated against the monitors connected now, or none for
/// the first free external screen. A present but malformed selector is rejected,
/// never replaced by another screen.
fn read_display_request(arg0: Option<&Value>) -> Result<DisplayRequest, LeaseError> {
    let Some(payload) = arg0 else {
        return Ok(DisplayRequest::Auto);
    };
    if let Some(value) = first_present(payload, &["displayId", "display_id"]) {
        return value
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| DisplayRequest::Id(id.to_string()))
            .ok_or(LeaseError::DisplayNotFound);
    }
    match first_present(
        payload,
        &[
            "displayIndex",
            "display_index",
            "monitorIndex",
            "monitor_index",
        ],
    ) {
        None => Ok(DisplayRequest::Auto),
        Some(value) => value
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|raw| raw.trim().parse::<usize>().ok())
            })
            .map(DisplayRequest::Index)
            .ok_or(LeaseError::DisplayNotFound),
    }
}

/// `None` stops the content; `Some` closes only that presentation. A present but
/// malformed token matches nothing instead of widening to the whole content.
fn read_presentation_token(arg0: Option<&Value>) -> Option<String> {
    let value = arg0.and_then(|payload| first_present(payload, &["token", "presentationToken"]))?;
    Some(
        value
            .as_str()
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
    )
}

/// Token of the presentation the renderer held when it issued an open. `None`
/// only starts a content without a lease; a present but malformed token is
/// rejected instead of being treated as none.
fn read_expected_token(arg0: Option<&Value>) -> Result<Option<String>, LeaseError> {
    let Some(value) =
        arg0.and_then(|payload| first_present(payload, &["expectedToken", "expected_token"]))
    else {
        return Ok(None);
    };
    value
        .as_str()
        .filter(|token| !token.trim().is_empty())
        .map(|token| Some(token.to_string()))
        .ok_or(LeaseError::PresentationChanged)
}

#[cfg(test)]
mod expected_token_tests {
    use super::*;

    #[test]
    fn an_expected_token_is_optional_but_never_malformed() {
        let parse = |payload: Value| read_expected_token(Some(&payload));
        assert_eq!(read_expected_token(None), Ok(None));
        assert_eq!(
            parse(serde_json::json!({ "contentType": "kitchen_display" })),
            Ok(None)
        );
        assert_eq!(
            parse(serde_json::json!({ "expectedToken": null })),
            Ok(None)
        );
        assert_eq!(
            parse(serde_json::json!({ "expectedToken": "t-1" })),
            Ok(Some("t-1".to_string()))
        );
        assert_eq!(
            parse(serde_json::json!({ "expected_token": "t-1" })),
            Ok(Some("t-1".to_string()))
        );
        for malformed in [
            serde_json::json!({ "expectedToken": "" }),
            serde_json::json!({ "expectedToken": "  " }),
            serde_json::json!({ "expectedToken": 7 }),
            serde_json::json!({ "expectedToken": ["t-1"] }),
        ] {
            assert_eq!(parse(malformed), Err(LeaseError::PresentationChanged));
        }
    }
}

fn display_error_json(
    content_type: &str,
    label: &str,
    code: &str,
    message: &str,
    occupied_by: Option<&str>,
) -> Value {
    serde_json::json!({
        "success": false,
        "supported": true,
        "code": code,
        "error": message,
        "contentType": content_type,
        "label": label,
        "occupiedBy": occupied_by,
    })
}

fn lease_error_json(content_type: &str, label: &str, error: &LeaseError) -> Value {
    let occupied_by = match error {
        LeaseError::Occupied(content) => Some(content.as_str()),
        _ => None,
    };
    display_error_json(
        content_type,
        label,
        error.code(),
        error.message(),
        occupied_by,
    )
}

/// Destroys the window of `instance` through its own handle, after every lock is
/// released: its Destroyed callback may run inside `destroy` and locks both tables.
/// The lease stays Closing until that callback. A handle already taken belongs to
/// a destroy in flight.
fn destroy_display_window(instance: u64) {
    let Some(window) = take_display_window(instance) else {
        return;
    };
    let _ = window.destroy();
}

/// Marks a built instance Closing, then destroys its window.
fn discard_display_window(content_type: &str, instance: u64) {
    display_leases().close_instance(content_type, instance);
    destroy_display_window(instance);
}

/// A registered window whose handle no longer answers is gone although its
/// Destroyed callback never ran. A taken handle is a destroy in flight, which that
/// callback settles.
fn display_window_gone(instance: u64) -> bool {
    let Some(window) = display_window(instance) else {
        return false;
    };
    window.is_visible().is_err()
}

/// Closes projections whose monitor disappeared or changed, and releases leases
/// whose window is gone although its Destroyed callback never ran. Windows are
/// probed and destroyed only outside the lease and window-map locks.
fn reconcile_display_leases(connected: &ConnectedMonitors) {
    let built = display_leases().built_instances();
    let gone: Vec<(String, u64)> = built
        .into_iter()
        .filter(|(_, instance)| display_window_gone(*instance))
        .collect();
    let stale = {
        let mut leases = display_leases();
        leases.release_missing(&gone);
        leases.reconcile(&connected.slots)
    };
    for (_, instance) in &gone {
        drop(take_display_window(*instance));
    }
    for (_, instance) in stale {
        destroy_display_window(instance);
    }
}

fn verify_on_monitor(window: &tauri::WebviewWindow, display_id: &str) -> Result<(), String> {
    match window.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) if monitor_id(&monitor) == display_id => Ok(()),
        _ => Err("The display window is not on the selected screen".to_string()),
    }
}

/// Runs off the event loop after a display window moved or changed scale. A window
/// that left its reserved monitor (for example moved onto the cashier's screen after
/// a disconnect) is closed instead of covering another screen.
fn enforce_display_placement(app: &tauri::AppHandle, content_type: &str, instance: u64) {
    let Ok(connected) = connected_monitors(app) else {
        return;
    };
    reconcile_display_leases(&connected);
    let reserved = display_leases()
        .lease(content_type)
        .filter(|lease| lease.instance == instance && lease.phase == LeasePhase::Active)
        .map(|lease| lease.display_id.clone());
    let Some(display_id) = reserved else {
        return;
    };
    let Some(window) = display_window(instance) else {
        return;
    };
    if verify_on_monitor(&window, &display_id).is_ok() {
        return;
    }
    let closing = display_leases().close_instance(content_type, instance);
    if closing {
        destroy_display_window(instance);
    }
}

const DISPLAY_STOPPED_WHILE_OPENING: &str = "The display was stopped while it was opening";

/// Builds the hidden, non-activating window, places it on the reserved monitor in
/// native physical pixels (global physical positions are never divided by a target
/// scale), verifies that monitor, then goes fullscreen and shows it.
fn present_display_window(
    app: &tauri::AppHandle,
    content_type: &str,
    label: &str,
    target: &tauri::Monitor,
    display_id: &str,
    instance: u64,
) -> Result<(), String> {
    let built = WebviewWindowBuilder::new(app, label, display_window_url(content_type))
        .title(display_window_title(content_type))
        .decorations(false)
        .resizable(true)
        .always_on_top(false)
        // A background projection never takes foreground focus from the cashier POS.
        .focused(false)
        .focusable(false)
        .visible(false)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            display_leases().abort(content_type, instance);
            return Err(error.to_string());
        }
    };
    register_display_window(instance, window.clone());
    let owner = content_type.to_string();
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Destroyed => {
            // One lock per statement: this may run inside a `destroy` call.
            display_leases().on_destroyed(&owner, instance);
            drop(take_display_window(instance));
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            let (app, content) = (handle.clone(), owner.clone());
            tauri::async_runtime::spawn_blocking(move || {
                enforce_display_placement(&app, &content, instance)
            });
        }
        _ => {}
    });
    display_leases().mark_built(content_type, instance);
    let position = target.position();
    let size = target.size();
    let placed = window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            position.x, position.y,
        )))
        .and_then(|()| {
            window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                size.width,
                size.height,
            )))
        })
        .map_err(|e| e.to_string())
        .and_then(|()| verify_on_monitor(&window, display_id))
        .and_then(|()| window.set_fullscreen(true).map_err(|e| e.to_string()));
    if let Err(error) = placed {
        discard_display_window(content_type, instance);
        return Err(error);
    }
    // A stop or disconnect that arrived while opening never flashes the window.
    let still_opening = display_leases()
        .lease(content_type)
        .is_some_and(|lease| lease.instance == instance && lease.phase == LeasePhase::Opening);
    if !still_opening {
        discard_display_window(content_type, instance);
        return Err(DISPLAY_STOPPED_WHILE_OPENING.to_string());
    }
    let shown = window
        .show()
        .map_err(|e| e.to_string())
        .and_then(|()| verify_on_monitor(&window, display_id));
    if let Err(error) = shown {
        discard_display_window(content_type, instance);
        return Err(error);
    }
    let activated = display_leases().activate(content_type, instance);
    if !activated {
        // Stopped or disconnected while showing: this window never becomes active.
        discard_display_window(content_type, instance);
        return Err(DISPLAY_STOPPED_WHILE_OPENING.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn display_list_monitors(app: tauri::AppHandle) -> Result<Value, String> {
    let connected = connected_monitors(&app)?;
    reconcile_display_leases(&connected);
    let leases = display_leases().leases().to_vec();
    Ok(capabilities_json(&connected, &leases))
}

#[tauri::command]
pub async fn display_open_window(
    app: tauri::AppHandle,
    arg0: Option<Value>,
) -> Result<Value, String> {
    let content_type = display_content_type(arg0.as_ref());
    let label = display_window_label(&content_type);
    let request = match read_display_request(arg0.as_ref()) {
        Ok(request) => request,
        Err(error) => return Ok(lease_error_json(&content_type, &label, &error)),
    };
    // The presentation the renderer held when it issued this open: only its current
    // token reopens a running content, so a late open never takes over a newer one.
    let expected = match read_expected_token(arg0.as_ref()) {
        Ok(expected) => expected,
        Err(error) => return Ok(lease_error_json(&content_type, &label, &error)),
    };
    // Native ownership is authoritative: resolve against the monitors connected
    // now, whatever capability list the renderer saw earlier.
    let connected = connected_monitors(&app)?;
    reconcile_display_leases(&connected);
    let token = uuid::Uuid::new_v4().to_string();
    // One short lock: selector validation, the compare-and-set on `expected` and the rotation.
    let reservation = display_leases().reserve(
        &content_type,
        &request,
        expected.as_deref(),
        &connected.slots,
        token.clone(),
    );
    let (display_id, reused) = match reservation {
        Err(error) => return Ok(lease_error_json(&content_type, &label, &error)),
        Ok(Reservation::Reused { display_id }) => (display_id, true),
        Ok(Reservation::Open {
            display_id,
            instance,
        }) => {
            let Some(index) = connected
                .slots
                .iter()
                .position(|slot| slot.id == display_id)
            else {
                display_leases().abort(&content_type, instance);
                return Ok(lease_error_json(
                    &content_type,
                    &label,
                    &LeaseError::DisplayNotFound,
                ));
            };
            let target = &connected.monitors[index];
            if let Err(error) =
                present_display_window(&app, &content_type, &label, target, &display_id, instance)
            {
                return Ok(display_error_json(
                    &content_type,
                    &label,
                    "display_open_failed",
                    &error,
                    None,
                ));
            }
            (display_id, false)
        }
    };
    let leases = display_leases().leases().to_vec();
    let display = connected
        .slots
        .iter()
        .position(|slot| slot.id == display_id)
        .map(|index| {
            let occupied_by = leases
                .iter()
                .find(|lease| lease.display_id == display_id)
                .map(|lease| lease.content.as_str());
            monitor_to_json(
                index,
                &connected.monitors[index],
                &connected.slots[index],
                occupied_by,
            )
        });
    Ok(serde_json::json!({
        "success": true,
        "supported": true,
        "contentType": content_type,
        "label": label,
        "token": token,
        "displayId": display_id,
        "activeDisplayId": display_id,
        "reused": reused,
        "display": display,
    }))
}

#[tauri::command]
pub async fn display_close_window(
    _app: tauri::AppHandle,
    arg0: Option<Value>,
) -> Result<Value, String> {
    let content_type = display_content_type(arg0.as_ref());
    let label = display_window_label(&content_type);
    // With a token only that presentation closes, so a delayed cleanup of an older
    // session cannot close a newer one. Without it this content stops. The other
    // content's window is never touched.
    let token = read_presentation_token(arg0.as_ref());
    let outcome = display_leases().begin_close(&content_type, token.as_deref());
    if let CloseOutcome::Destroy(instance) = outcome {
        destroy_display_window(instance);
    }
    let leases = display_leases().leases().to_vec();
    Ok(serde_json::json!({
        "success": true,
        "contentType": content_type,
        "label": label,
        "closed": outcome != CloseOutcome::NotFound,
        "stale": token.is_some() && outcome == CloseOutcome::NotFound,
        "activePresentations": presentations_json(&leases),
    }))
}

#[cfg(test)]
mod display_request_tests {
    use super::*;

    #[test]
    fn selectors_are_explicit_or_rejected_never_redirected() {
        assert_eq!(read_display_request(None), Ok(DisplayRequest::Auto));
        let parse = |payload: Value| read_display_request(Some(&payload));
        assert_eq!(
            parse(serde_json::json!({ "contentType": "kitchen_display" })),
            Ok(DisplayRequest::Auto)
        );
        assert_eq!(
            parse(serde_json::json!({ "displayId": "b" })),
            Ok(DisplayRequest::Id("b".into()))
        );
        assert_eq!(
            parse(serde_json::json!({ "displayIndex": 2 })),
            Ok(DisplayRequest::Index(2))
        );
        for malformed in [
            serde_json::json!({ "displayId": "" }),
            serde_json::json!({ "displayId": 3 }),
            serde_json::json!({ "displayIndex": -1 }),
            serde_json::json!({ "displayIndex": "second" }),
        ] {
            assert_eq!(parse(malformed), Err(LeaseError::DisplayNotFound));
        }
        assert_eq!(read_presentation_token(None), None);
        assert_eq!(
            read_presentation_token(Some(
                &serde_json::json!({ "contentType": "kitchen_display" })
            )),
            None
        );
        assert_eq!(
            read_presentation_token(Some(&serde_json::json!({ "token": "t1" }))),
            Some("t1".into())
        );
        assert_eq!(
            read_presentation_token(Some(&serde_json::json!({ "token": 5 }))),
            Some(String::new())
        );
    }
}

#[tauri::command]
pub async fn clipboard_read_text(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    match crate::read_system_clipboard_text() {
        Ok(text) => {
            let _ =
                crate::write_local_json(&db, "clipboard_fallback_text", &serde_json::json!(text));
            Ok(serde_json::json!(text))
        }
        Err(_) => {
            let fallback = crate::read_local_json(&db, "clipboard_fallback_text")?;
            Ok(serde_json::json!(fallback
                .as_str()
                .unwrap_or_default()
                .to_string()))
        }
    }
}

#[tauri::command]
pub async fn clipboard_write_text(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let text = parse_clipboard_text_payload(arg0)?;
    let _ = crate::write_local_json(&db, "clipboard_fallback_text", &serde_json::json!(text));
    let _ = crate::write_system_clipboard_text(&text);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn show_notification(arg0: Option<Value>) -> Result<Value, String> {
    let (title, body) = parse_notification_payload(arg0);
    info!(title = %title, body = %body, "show-notification requested");
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn window_start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_get_position(window: tauri::Window) -> Result<Value, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "x": position.x,
        "y": position.y,
    }))
}

#[tauri::command]
pub async fn window_set_position(window: tauri::Window, arg0: Option<Value>) -> Result<(), String> {
    let (x, y) = parse_window_position_payload(arg0)?;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_get_state(window: tauri::Window) -> Result<Value, String> {
    let state = current_window_state(&window);
    emit_window_state_changed(&window);
    Ok(state)
}

#[tauri::command]
pub async fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())?;
    emit_window_state_changed(&window);
    Ok(())
}

#[tauri::command]
pub async fn window_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    emit_window_state_changed(&window);
    Ok(())
}

#[tauri::command]
pub async fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_toggle_fullscreen(window: tauri::Window) -> Result<(), String> {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())?;
    emit_window_state_changed(&window);
    Ok(())
}

#[tauri::command]
pub async fn window_reload(window: tauri::Window) -> Result<(), String> {
    current_webview(&window)?
        .reload()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_force_reload(window: tauri::Window) -> Result<(), String> {
    current_webview(&window)?
        .eval("window.location.reload();")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn window_toggle_devtools(window: tauri::Window) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let webview = current_webview(&window)?;
        if webview.is_devtools_open() {
            webview.close_devtools();
        } else {
            webview.open_devtools();
        }
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = window;
        Err("Developer tools are only available in debug builds".to_string())
    }
}

#[tauri::command]
pub async fn window_zoom_in(window: tauri::Window) -> Result<(), String> {
    set_window_zoom(&window, current_zoom_scale(&window) + WINDOW_ZOOM_STEP)
}

#[tauri::command]
pub async fn window_zoom_out(window: tauri::Window) -> Result<(), String> {
    set_window_zoom(&window, current_zoom_scale(&window) - WINDOW_ZOOM_STEP)
}

#[tauri::command]
pub async fn window_zoom_reset(window: tauri::Window) -> Result<(), String> {
    set_window_zoom(&window, WINDOW_ZOOM_DEFAULT)
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn system_settings_allowlist_maps_only_documented_pages() {
        for (section, uri) in [
            ("display", "ms-settings:display"),
            ("sound", "ms-settings:sound"),
            ("touch", "ms-settings:easeofaccess-mousepointer"),
            ("power", "ms-settings:powersleep"),
        ] {
            let parsed =
                parse_system_settings_payload(Some(serde_json::json!({ "section": section })))
                    .expect("documented section should parse");
            assert_eq!(system_settings_uri(parsed), uri);
            assert_eq!(serde_json::to_value(parsed).unwrap(), section);
        }
    }

    #[test]
    fn system_settings_allowlist_rejects_uri_command_and_malformed_payloads() {
        for payload in [
            None,
            Some(Value::Null),
            Some(serde_json::json!("display")),
            Some(serde_json::json!({})),
            Some(serde_json::json!({ "section": "ms-settings:privacy-webcam" })),
            Some(serde_json::json!({ "section": "display & calc.exe" })),
            Some(serde_json::json!({ "section": "display\u{0000}sound" })),
            Some(serde_json::json!({ "section": "display", "uri": "file:///C:/test.exe" })),
            Some(serde_json::json!({ "section": "network" })),
            Some(serde_json::json!({ "section": 1 })),
        ] {
            assert!(parse_system_settings_payload(payload).is_err());
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn system_settings_launch_is_explicitly_unsupported_off_windows() {
        assert_eq!(
            launch_system_settings(system_settings_uri(SystemSettingsSection::Display)),
            Err("Opening system settings is supported only on Windows".to_string())
        );
    }

    #[test]
    fn parse_clipboard_text_payload_supports_string_and_object() {
        let from_string = parse_clipboard_text_payload(Some(serde_json::json!("hello world")))
            .expect("string payload should parse");
        let from_object = parse_clipboard_text_payload(Some(serde_json::json!({
            "text": "receipt copied"
        })))
        .expect("object payload should parse");
        assert_eq!(from_string, "hello world");
        assert_eq!(from_object, "receipt copied");
    }

    #[test]
    fn parse_clipboard_text_payload_rejects_oversized_text() {
        let oversized = "a".repeat(MAX_CLIPBOARD_TEXT_LEN + 1);
        let err = parse_clipboard_text_payload(Some(serde_json::json!(oversized)))
            .expect_err("oversized payload should fail");
        assert!(err.contains("Clipboard payload too large"));
    }

    #[test]
    fn parse_notification_payload_supports_string_and_object() {
        let from_string = parse_notification_payload(Some(serde_json::json!("Sync complete")));
        let from_object = parse_notification_payload(Some(serde_json::json!({
            "title": "Print",
            "message": "Job queued"
        })));
        assert_eq!(from_string.0, "The Small POS");
        assert_eq!(from_string.1, "Sync complete");
        assert_eq!(from_object.0, "Print");
        assert_eq!(from_object.1, "Job queued");
    }
}

// The connected KDS is a local consumer of the main POS owner. Keep the native
// event-emission denies: these commands cannot target arbitrary windows/events.
static KDS_DISPLAY_SNAPSHOT: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn kds_display_publish(
    webview: tauri::Webview,
    arg0: Option<Value>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the POS owner may publish KDS data".into());
    }
    *KDS_DISPLAY_SNAPSHOT.lock().map_err(|e| e.to_string())? = arg0;
    Ok(())
}

#[tauri::command]
pub async fn kds_display_snapshot(webview: tauri::Webview) -> Result<Option<Value>, String> {
    if webview.label() != "external-display-kitchen_display" {
        return Err("Only the connected KDS may read its snapshot".into());
    }
    Ok(KDS_DISPLAY_SNAPSHOT
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}

#[tauri::command]
pub async fn kds_display_intent(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    arg0: Value,
) -> Result<(), String> {
    if webview.label() != "external-display-kitchen_display" {
        return Err("Only the connected KDS may send KDS actions".into());
    }
    app.emit_to("main", "kds-display-intent", arg0)
        .map_err(|e| e.to_string())
}

// Customer-facing receiver has read-only access to its sanitized local snapshot.
static CUSTOMER_DISPLAY_SNAPSHOT: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn customer_display_publish(
    webview: tauri::Webview,
    arg0: Option<Value>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the POS owner may publish customer display data".into());
    }
    *CUSTOMER_DISPLAY_SNAPSHOT
        .lock()
        .map_err(|e| e.to_string())? = arg0;
    Ok(())
}

#[tauri::command]
pub async fn customer_display_snapshot(webview: tauri::Webview) -> Result<Option<Value>, String> {
    if webview.label() != "external-display-customer_display" {
        return Err("Only the connected customer display may read its snapshot".into());
    }
    Ok(CUSTOMER_DISPLAY_SNAPSHOT
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}

/// Local custom commands do not inherit plugin ACL restrictions. Apply the
/// receiver allowlist before dispatch, retaining all existing non-receiver behavior.
pub(crate) fn display_receiver_command_allowed(label: &str, command: &str) -> bool {
    match label {
        "external-display-kitchen_display" => {
            matches!(command, "kds_display_snapshot" | "kds_display_intent")
        }
        "external-display-customer_display" => command == "customer_display_snapshot",
        _ => true,
    }
}

#[cfg(test)]
mod display_receiver_isolation_tests {
    use super::display_receiver_command_allowed;
    #[test]
    fn receiver_command_matrix_rejects_generic_pos_access() {
        for label in [
            "external-display-kitchen_display",
            "external-display-customer_display",
        ] {
            for command in [
                "api_fetch_from_admin",
                "settings_get",
                "terminal_config_get_full_config",
                "modules_get_cached",
                "orders_get_all",
                "customers_get_all",
                "kds_display_publish",
                "customer_display_publish",
                "display_open_window",
            ] {
                assert!(
                    !display_receiver_command_allowed(label, command),
                    "{label} must deny {command}"
                );
                assert!(display_receiver_command_allowed("main", command));
                assert!(display_receiver_command_allowed(
                    "unrelated-existing-window",
                    command
                ));
            }
        }
        assert!(display_receiver_command_allowed(
            "external-display-kitchen_display",
            "kds_display_snapshot"
        ));
        assert!(display_receiver_command_allowed(
            "external-display-kitchen_display",
            "kds_display_intent"
        ));
        assert!(display_receiver_command_allowed(
            "external-display-customer_display",
            "customer_display_snapshot"
        ));
        assert!(!display_receiver_command_allowed(
            "external-display-customer_display",
            "kds_display_intent"
        ));
        assert!(!display_receiver_command_allowed(
            "external-display-kitchen_display",
            "customer_display_snapshot"
        ));
    }
}
