//! efood Partner (Live Orders) hosted inside the POS window.
//!
//! efood keeps a shop closed as `close_unreachable` unless one of its own
//! devices is connected, and its Partner API has no way to say "the POS is
//! here" (efood, 15/09/2026: their equipment stays required as the fallback
//! for orders that fail to transmit). The founder wants no separate browser
//! on the till, so the POS hosts efood's own web app in a second WebView2
//! inside the main window: staff reach it as a module, and it stays alive
//! while other modules are in use, so efood sees its equipment connected all
//! day.
//!
//! The page is efood's, not ours: the webview has no IPC access, popups are
//! refused (an efood link opens in place instead) and navigation away from
//! efood is blocked. When another module is shown the webview is parked at
//! 2x2 logical pixels in the top-left corner instead of hidden, because a
//! hidden page is throttled by the browser and efood's connection keep-alive
//! must keep running.

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

pub const EFOOD_PARTNER_LABEL: &str = "efood-partner";
pub const EFOOD_PARTNER_HOME_URL: &str = "https://partner-app.e-food.gr/live-orders";
const MAIN_WINDOW_LABEL: &str = "main";
const PARKED_SIZE: f64 = 2.0;
const MAX_BOUNDS: f64 = 16_384.0;
/// efood's own hosts, plus Delivery Hero's (the Partner Portal is theirs).
const ALLOWED_HOSTS: &[&str] = &["e-food.gr", "deliveryhero.io", "deliveryhero.com"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

struct State {
    parked: bool,
    muted: bool,
    /// The last mute request the webview did not accept. The button replaces
    /// what staff used to do in the browser's own settings, so a mute that
    /// failed must never read back as a silenced page.
    mute_failed: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    parked: true,
    muted: DEFAULT_MUTED,
    mute_failed: false,
});

/// efood's page rings for a new order and the POS plugin's own modal rings
/// straight after it, so the till alerts twice for one order. Staff silenced
/// efood's half in the browser's site settings before the page moved into the
/// POS window, where those settings are out of reach: start silenced, and let
/// the module's own button turn it back on.
const DEFAULT_MUTED: bool = true;

/// How long a mute request may take to come back from the UI thread.
#[cfg(windows)]
const MUTE_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Reads `bounds: {x, y, width, height}` in logical pixels from a command
/// payload. The renderer measures its surface with fractional CSS pixels;
/// the webview wants whole ones.
pub fn parse_bounds(payload: Option<&Value>) -> Result<Bounds, String> {
    let bounds = payload
        .and_then(|value| value.get("bounds"))
        .filter(|value| value.is_object())
        .ok_or_else(|| "Missing efood Partner bounds".to_string())?;
    let read = |key: &str| -> Result<f64, String> {
        bounds
            .get(key)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
            .ok_or_else(|| format!("Missing efood Partner bounds.{key}"))
    };
    let (x, y, width, height) = (read("x")?, read("y")?, read("width")?, read("height")?);
    if !(0.0..=MAX_BOUNDS).contains(&x) || !(0.0..=MAX_BOUNDS).contains(&y) {
        return Err("efood Partner bounds position is out of range".to_string());
    }
    if !(1.0..=MAX_BOUNDS).contains(&width) || !(1.0..=MAX_BOUNDS).contains(&height) {
        return Err("efood Partner bounds size is out of range".to_string());
    }
    Ok(Bounds {
        x: x.round(),
        y: y.round(),
        width: width.round(),
        height: height.round(),
    })
}

/// Only efood's (and Delivery Hero's) pages may load in the hosted webview.
pub fn is_allowed_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return url.as_str() == "about:blank";
    }
    url.host_str().is_some_and(|host| {
        let host = host.to_ascii_lowercase();
        ALLOWED_HOSTS
            .iter()
            .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
    })
}

fn payload_url(payload: Option<&Value>) -> Result<Url, String> {
    let raw = payload
        .and_then(|value| crate::value_str(value, &["url"]))
        .unwrap_or_else(|| EFOOD_PARTNER_HOME_URL.to_string());
    let url = Url::parse(&raw).map_err(|error| format!("Invalid efood Partner url: {error}"))?;
    if !is_allowed_url(&url) {
        return Err("efood Partner url must be an efood page".to_string());
    }
    Ok(url)
}

fn payload_muted(payload: Option<&Value>) -> Option<bool> {
    payload
        .and_then(|value| value.get("muted"))
        .and_then(Value::as_bool)
}

fn parked_bounds() -> Bounds {
    Bounds {
        x: 0.0,
        y: 0.0,
        width: PARKED_SIZE,
        height: PARKED_SIZE,
    }
}

fn set_state(parked: Option<bool>, muted: Option<bool>) {
    if let Ok(mut state) = STATE.lock() {
        if let Some(parked) = parked {
            state.parked = parked;
        }
        if let Some(muted) = muted {
            state.muted = muted;
        }
    }
}

fn set_mute_failed(failed: bool) {
    if let Ok(mut state) = STATE.lock() {
        state.mute_failed = failed;
    }
}

fn status_json(app: &AppHandle) -> Value {
    let webview = app.get_webview(EFOOD_PARTNER_LABEL);
    let (parked, muted, mute_failed) = STATE
        .lock()
        .map(|state| (state.parked, state.muted, state.mute_failed))
        .unwrap_or((true, DEFAULT_MUTED, false));
    json!({
        "success": true,
        "exists": webview.is_some(),
        "parked": parked,
        "muted": muted,
        "muteFailed": mute_failed,
        "url": webview.and_then(|webview| webview.url().ok()).map(|url| url.to_string()),
    })
}

/// Clip a requested rectangle to a window content area of `width` x `height`
/// logical pixels.
///
/// The child webview is a sibling of the main one, not a child of any DOM
/// element, so no CSS can contain it: it is painted exactly where it is put.
/// The renderer measures its surface and can only ever be a frame behind the
/// window — during a resize, a maximize, or a scale-factor change its numbers
/// describe a window that no longer exists, and efood's page ends up hanging
/// past the container it is supposed to sit in. This is the last word on
/// placement, because it is the only place that knows the window's real size at
/// the moment the bounds are applied.
///
/// `None` means there is nothing left to show (the surface is entirely outside
/// the window); the caller parks instead of placing a sliver.
pub fn clip_to_window(bounds: Bounds, width: f64, height: f64) -> Option<Bounds> {
    if !(width.is_finite() && height.is_finite()) || width < 1.0 || height < 1.0 {
        return None;
    }
    let left = bounds.x.max(0.0);
    let top = bounds.y.max(0.0);
    let right = (bounds.x + bounds.width).min(width);
    let bottom = (bounds.y + bounds.height).min(height);
    if right - left < 1.0 || bottom - top < 1.0 {
        return None;
    }
    Some(Bounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

/// The POS window's content area in logical pixels, or `None` when it cannot be
/// read — in which case the caller places what it was given rather than
/// refusing, since a missing measurement is not evidence of a bad one.
fn window_content_size(app: &AppHandle) -> Option<(f64, f64)> {
    let window = app.get_window("main")?;
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?;
    let logical = size.to_logical::<f64>(scale);
    Some((logical.width, logical.height))
}

fn apply_bounds(app: &AppHandle, webview: &tauri::Webview, bounds: Bounds) -> Result<(), String> {
    let clipped = match window_content_size(app) {
        Some((width, height)) => clip_to_window(bounds, width, height),
        None => Some(bounds),
    };
    let Some(bounds) = clipped else {
        // Nothing of the surface is on screen. Park rather than paint a sliver
        // of efood's page over whatever is there.
        let parked = parked_bounds();
        webview
            .set_position(LogicalPosition::new(parked.x, parked.y))
            .map_err(|error| error.to_string())?;
        return webview
            .set_size(LogicalSize::new(parked.width, parked.height))
            .map_err(|error| error.to_string());
    };
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| error.to_string())
}

/// Silences (or unsilences) efood's page the same way the browser's own
/// "mute site" does: WebView2 mutes the whole webview, whatever the page plays.
///
/// The closure runs on the UI thread, so it reports back what it actually did
/// rather than dropping the failure: a button that says "sound off" while the
/// page keeps ringing is the exact problem this control exists to solve.
#[cfg(windows)]
fn apply_muted(webview: &tauri::Webview, muted: bool) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    webview
        .with_webview(move |platform| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
            use windows::core::Interface;

            let outcome = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| format!("efood page is not ready yet ({error})"))?;
                let core = core.cast::<ICoreWebView2_8>().map_err(|error| {
                    format!("this WebView2 runtime cannot mute audio ({error})")
                })?;
                unsafe { core.SetIsMuted(muted) }
                    .map_err(|error| format!("WebView2 refused the sound change ({error})"))
            })();
            let _ = tx.send(outcome);
        })
        .map_err(|error| error.to_string())?;
    rx.recv_timeout(MUTE_ACK_TIMEOUT)
        .map_err(|_| "efood page did not answer the sound change".to_string())?
}

#[cfg(not(windows))]
fn apply_muted(_webview: &tauri::Webview, _muted: bool) -> Result<(), String> {
    Ok(())
}

/// Placement must not fail because the sound did not change: the page is still
/// usable muted or not. The failure is recorded instead, and `status` carries
/// it to the module, which says so next to the button.
fn apply_muted_best_effort(webview: &tauri::Webview, muted: bool) {
    set_mute_failed(apply_muted(webview, muted).is_err());
}

fn ensure_webview(app: &AppHandle, url: Url, bounds: Bounds) -> Result<tauri::Webview, String> {
    if let Some(existing) = app.get_webview(EFOOD_PARTNER_LABEL) {
        return Ok(existing);
    }
    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    let popup_app = app.clone();
    let builder = WebviewBuilder::new(EFOOD_PARTNER_LABEL, WebviewUrl::External(url))
        .on_navigation(is_allowed_url)
        .on_new_window(move |url, _features| {
            // Nothing may open a window over the POS. An efood link that asks
            // for one opens in place instead.
            if is_allowed_url(&url) {
                if let Some(webview) = popup_app.get_webview(EFOOD_PARTNER_LABEL) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .zoom_hotkeys_enabled(false)
        .focused(false);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())?;
    let muted = STATE
        .lock()
        .map(|state| state.muted)
        .unwrap_or(DEFAULT_MUTED);
    if muted {
        apply_muted_best_effort(&webview, true);
    }
    Ok(webview)
}

/// Loads efood's page parked in the corner, so efood sees its equipment
/// connected from the moment the register starts.
#[tauri::command]
pub async fn efood_partner_ensure(app: AppHandle, arg0: Option<Value>) -> Result<Value, String> {
    let url = payload_url(arg0.as_ref())?;
    set_state(None, payload_muted(arg0.as_ref()));
    let webview = ensure_webview(&app, url, parked_bounds())?;
    if let Some(muted) = payload_muted(arg0.as_ref()) {
        apply_muted_best_effort(&webview, muted);
    }
    Ok(status_json(&app))
}

/// Shows the page over the module surface the renderer measured.
#[tauri::command]
pub async fn efood_partner_show(app: AppHandle, arg0: Option<Value>) -> Result<Value, String> {
    let url = payload_url(arg0.as_ref())?;
    let bounds = parse_bounds(arg0.as_ref())?;
    set_state(None, payload_muted(arg0.as_ref()));
    let webview = ensure_webview(&app, url, bounds)?;
    apply_bounds(&app, &webview, bounds)?;
    if let Some(muted) = payload_muted(arg0.as_ref()) {
        apply_muted_best_effort(&webview, muted);
    }
    set_state(Some(false), None);
    Ok(status_json(&app))
}

/// Parks the page out of the way while another module is shown; it keeps
/// running.
#[tauri::command]
pub async fn efood_partner_park(app: AppHandle) -> Result<Value, String> {
    if let Some(webview) = app.get_webview(EFOOD_PARTNER_LABEL) {
        apply_bounds(&app, &webview, parked_bounds())?;
    }
    set_state(Some(true), None);
    Ok(status_json(&app))
}

#[tauri::command]
pub async fn efood_partner_close(app: AppHandle) -> Result<Value, String> {
    if let Some(webview) = app.get_webview(EFOOD_PARTNER_LABEL) {
        webview.close().map_err(|error| error.to_string())?;
    }
    set_state(Some(true), None);
    Ok(status_json(&app))
}

#[tauri::command]
pub async fn efood_partner_status(app: AppHandle) -> Result<Value, String> {
    Ok(status_json(&app))
}

/// Loads an efood page again (the Live Orders page when none is given).
#[tauri::command]
pub async fn efood_partner_navigate(app: AppHandle, arg0: Option<Value>) -> Result<Value, String> {
    let url = payload_url(arg0.as_ref())?;
    let webview = app
        .get_webview(EFOOD_PARTNER_LABEL)
        .ok_or_else(|| "efood Partner page is not loaded".to_string())?;
    webview.navigate(url).map_err(|error| error.to_string())?;
    Ok(status_json(&app))
}

#[tauri::command]
pub async fn efood_partner_set_muted(app: AppHandle, arg0: Option<Value>) -> Result<Value, String> {
    let muted = payload_muted(arg0.as_ref())
        .ok_or_else(|| "Missing efood Partner muted flag".to_string())?;
    // Apply first, record second: the module reverts its button on an error,
    // and the stored state must match what the page is really doing.
    if let Some(webview) = app.get_webview(EFOOD_PARTNER_LABEL) {
        if let Err(error) = apply_muted(&webview, muted) {
            set_mute_failed(true);
            return Err(error);
        }
    }
    set_mute_failed(false);
    set_state(None, Some(muted));
    Ok(status_json(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test url")
    }

    #[test]
    fn bounds_round_to_whole_logical_pixels() {
        let payload =
            json!({ "bounds": { "x": 120.4, "y": 40.6, "width": 900.2, "height": 610.7 } });
        assert_eq!(
            parse_bounds(Some(&payload)),
            Ok(Bounds {
                x: 120.0,
                y: 41.0,
                width: 900.0,
                height: 611.0
            })
        );
    }

    #[test]
    fn bounds_must_be_present_positive_and_sane() {
        assert!(parse_bounds(None).is_err());
        assert!(parse_bounds(Some(
            &json!({ "bounds": { "x": 0, "y": 0, "width": 0, "height": 10 } })
        ))
        .is_err());
        assert!(parse_bounds(Some(
            &json!({ "bounds": { "x": -1, "y": 0, "width": 10, "height": 10 } })
        ))
        .is_err());
        assert!(parse_bounds(Some(&json!({ "bounds": { "x": 0, "y": 0, "width": 10 } }))).is_err());
        assert!(parse_bounds(Some(
            &json!({ "bounds": { "x": 0, "y": 0, "width": 1e9, "height": 10 } })
        ))
        .is_err());
        assert!(parse_bounds(Some(&json!({ "bounds": "wide" }))).is_err());
    }

    #[test]
    fn only_efood_pages_may_load() {
        assert!(is_allowed_url(&url(EFOOD_PARTNER_HOME_URL)));
        assert!(is_allowed_url(&url(
            "https://partner-app.e-food.gr/login?next=/live-orders"
        )));
        assert!(is_allowed_url(&url("https://E-FOOD.gr/")));
        assert!(is_allowed_url(&url("https://auth.deliveryhero.io/session")));
        assert!(is_allowed_url(&url("about:blank")));
        assert!(!is_allowed_url(&url(
            "http://partner-app.e-food.gr/live-orders"
        )));
        assert!(!is_allowed_url(&url(
            "https://partner-app.e-food.gr.evil.example/"
        )));
        assert!(!is_allowed_url(&url("https://example.com/e-food.gr")));
        assert!(!is_allowed_url(&url("file:///C:/Windows/system.ini")));
    }

    #[test]
    fn the_payload_url_defaults_to_live_orders_and_refuses_foreign_pages() {
        assert_eq!(
            payload_url(None).map(|u| u.to_string()),
            Ok(EFOOD_PARTNER_HOME_URL.to_string())
        );
        assert_eq!(
            payload_url(Some(
                &json!({ "url": "https://partner-app.e-food.gr/orders" })
            ))
            .map(|u| u.to_string()),
            Ok("https://partner-app.e-food.gr/orders".to_string())
        );
        assert!(payload_url(Some(&json!({ "url": "https://example.com/" }))).is_err());
        assert!(payload_url(Some(&json!({ "url": "not a url" }))).is_err());
    }
    #[test]
    fn the_page_is_clipped_to_the_window_it_is_painted_in() {
        // Nothing in CSS can contain this webview: it is a sibling of the whole
        // page, so the rectangle it is given is exactly where it lands.
        let bounds = Bounds {
            x: 120.0,
            y: 40.0,
            width: 1400.0,
            height: 900.0,
        };
        assert_eq!(
            clip_to_window(bounds, 1280.0, 800.0),
            Some(Bounds {
                x: 120.0,
                y: 40.0,
                width: 1160.0,
                height: 760.0
            })
        );
    }

    #[test]
    fn a_surface_starting_outside_the_window_is_pulled_back_inside() {
        let bounds = Bounds {
            x: -60.0,
            y: -30.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(
            clip_to_window(bounds, 1280.0, 800.0),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 740.0,
                height: 570.0
            })
        );
    }

    #[test]
    fn a_fitting_surface_is_left_exactly_where_the_renderer_measured_it() {
        let bounds = Bounds {
            x: 120.0,
            y: 41.0,
            width: 900.0,
            height: 611.0,
        };
        assert_eq!(clip_to_window(bounds, 1280.0, 800.0), Some(bounds));
    }

    #[test]
    fn nothing_on_screen_is_reported_as_nothing_rather_than_a_sliver() {
        // `apply_bounds` parks on None. Painting the leftover pixel column of
        // efood's page over another module is worse than not showing it.
        let past_right = Bounds {
            x: 1400.0,
            y: 40.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(clip_to_window(past_right, 1280.0, 800.0), None);
        let above = Bounds {
            x: 20.0,
            y: -900.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(clip_to_window(above, 1280.0, 800.0), None);
        let sub_pixel = Bounds {
            x: 1279.5,
            y: 40.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(clip_to_window(sub_pixel, 1280.0, 800.0), None);
    }

    #[test]
    fn an_unusable_window_measurement_clips_to_nothing() {
        let bounds = Bounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(clip_to_window(bounds, 0.0, 0.0), None);
        assert_eq!(clip_to_window(bounds, f64::NAN, 800.0), None);
        assert_eq!(clip_to_window(bounds, 1280.0, f64::INFINITY), None);
    }

    #[test]
    fn the_page_starts_silenced_because_the_browser_switch_is_out_of_reach() {
        // efood's page rings for a new order and the POS plugin's modal rings
        // straight after it. Staff silenced efood's half in the browser's site
        // settings; inside the POS window there is no such setting, so the
        // module's button is the only one and it starts on.
        assert!(DEFAULT_MUTED);
    }

    #[test]
    fn the_mute_flag_is_read_only_when_the_caller_really_sent_one() {
        assert_eq!(payload_muted(Some(&json!({ "muted": true }))), Some(true));
        assert_eq!(payload_muted(Some(&json!({ "muted": false }))), Some(false));
        // Absent or not a boolean means "leave the sound as it is", never
        // "unmute": show/ensure pass it through on every placement.
        assert_eq!(payload_muted(Some(&json!({ "url": "x" }))), None);
        assert_eq!(payload_muted(Some(&json!({ "muted": "true" }))), None);
        assert_eq!(payload_muted(None), None);
    }
}
