//! One-shot main-webview capture. No desktop APIs, capture files or durable pixels.
use super::{contracts, critical_op::SupportPermit, evidence};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

static READY: AtomicBool = AtomicBool::new(false);
fn app_slot() -> &'static Mutex<Option<tauri::AppHandle>> {
    static APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    APP.get_or_init(Default::default)
}
/// The POS's own webview carries the window's label. Any other webview of the window is a child (a
/// delivery platform's partner page) that sits parked at 2x2 logical pixels while it is hidden.
fn main_view(window: &tauri::Window) -> Option<tauri::Webview> {
    window
        .webviews()
        .into_iter()
        .find(|view| view.label() == window.label())
}
/// Only a child that is actually on screen blocks a capture: its page is not ours to photograph, and
/// the POS webview alone would not be what staff see. A parked child blocks nothing. A size that cannot
/// be read counts as showing.
fn child_showing(window: &tauri::Window) -> bool {
    window.webviews().into_iter().any(|view| {
        view.label() != window.label()
            && view
                .size()
                .map(|size| size.width > PARKED_CHILD_MAX_PX || size.height > PARKED_CHILD_MAX_PX)
                .unwrap_or(true)
    })
}
/// Parked children are 2 logical pixels; this leaves room for display scaling up to 400%.
const PARKED_CHILD_MAX_PX: u32 = 8;
pub fn install(app: &tauri::AppHandle) {
    if let Ok(mut slot) = app_slot().lock() {
        if READY.load(Ordering::Acquire) {
            return;
        }
        *slot = Some(app.clone());
    }
    #[cfg(windows)]
    if let Some(view) = app.get_window("main").and_then(|window| main_view(&window)) {
        let _ = view.with_webview(|native| {
            READY.store(
                unsafe { native.controller().CoreWebView2() }.is_ok(),
                Ordering::Release,
            );
        });
    }
}
pub fn application() -> Option<tauri::AppHandle> {
    app_slot().lock().ok().and_then(|s| s.clone())
}
pub fn available() -> bool {
    READY.load(Ordering::Acquire)
}
pub fn input(value: &Value) -> Result<(String, u32), String> {
    if value.as_object().is_none_or(|m| {
        m.keys()
            .any(|k| !["reason", "max_edge"].contains(&k.as_str()))
    }) {
        return Err("INVALID_INPUT".into());
    }
    let reason = evidence::reason(value)?.ok_or("INVALID_INPUT")?;
    let edge = match value.get("max_edge") {
        None => contracts::cap("screenshot", "defaultEdge"),
        Some(v) => v.as_u64().ok_or("INVALID_INPUT")?,
    };
    if !(contracts::cap("screenshot", "minEdge")..=contracts::cap("screenshot", "maxEdge"))
        .contains(&edge)
    {
        return Err("INVALID_INPUT".into());
    }
    Ok((reason, edge as u32))
}
fn check(permit: &SupportPermit, deadline: Instant) -> Result<(), String> {
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    if Instant::now() >= deadline {
        return Err(evidence::error("SCREEN_CAPTURE_FAILED"));
    }
    Ok(())
}
fn receive<T>(
    rx: std::sync::mpsc::Receiver<T>,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<T, String> {
    loop {
        check(permit, deadline)?;
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(v) => return Ok(v),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
            Err(_) => return Err(evidence::error("SCREEN_CAPTURE_FAILED")),
        }
    }
}
fn script(
    view: &tauri::Webview,
    code: &str,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    view.eval_with_callback(code, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|_| evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))?;
    serde_json::from_str(&receive(rx, permit, deadline)?)
        .map_err(|_| evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))
}
pub fn guard_result(state: &str) -> Result<(), String> {
    match state {
        "ready" => Ok(()),
        "SCREEN_CONTAINS_SECRETS" | "changed" => Err(evidence::error("SCREEN_CONTAINS_SECRETS")),
        _ => Err(evidence::error("SCREEN_CAPTURE_UNAVAILABLE")),
    }
}
pub fn capture(max_edge: u32, permit: &SupportPermit) -> Result<Value, String> {
    if !available() {
        return Err(evidence::error("SCREEN_CAPTURE_UNAVAILABLE"));
    }
    let app = app_slot()
        .lock()
        .ok()
        .and_then(|a| a.clone())
        .ok_or_else(|| evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))?;
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || child_showing(&window)
    {
        return Err(evidence::error("SCREEN_CAPTURE_UNAVAILABLE"));
    }
    let view = main_view(&window).ok_or_else(|| evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))?;
    struct Cleanup<'a>(&'a tauri::Webview);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            let _=self.0.eval("window.__supportCaptureGuard?.observer.disconnect(); delete window.__supportCaptureGuard;");
        }
    }
    let _cleanup = Cleanup(&view);
    let deadline = Instant::now() + Duration::from_secs(5);
    let before = script(&view, include_str!("screenshot_guard.js"), permit, deadline)?;
    guard_result(&before)?;
    let pixels = native_capture(&view, permit, deadline);
    let after = script(&view,"(() => { const g=window.__supportCaptureGuard; if (!g) return false; g.observer.disconnect(); delete window.__supportCaptureGuard; return g.changed || !g.safe() ? 'changed' : 'ready'; })()",permit,deadline)?;
    guard_result(&after)?;
    // A child that came on screen during the capture makes the picture stale.
    if child_showing(&window) {
        return Err(evidence::error("SCREEN_CAPTURE_UNAVAILABLE"));
    }
    let bytes = pixels?;
    let dimensions =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png)
            .into_dimensions()
            .map_err(|_| evidence::error("SCREEN_CAPTURE_FAILED"))?;
    if u64::from(dimensions.0) * u64::from(dimensions.1) > 16_777_216 {
        return Err(evidence::error("SCREEN_CAPTURE_UNAVAILABLE"));
    }
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| evidence::error("SCREEN_CAPTURE_FAILED"))?;
    drop(bytes);
    encode(image, max_edge, permit, deadline)
}
#[cfg(windows)]
fn native_capture(
    view: &tauri::Webview,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, StructuredStorage::CreateStreamOnHGlobal,
        COINIT_MULTITHREADED, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
    };
    let (tx, rx) = std::sync::mpsc::channel();
    let cancel = permit.cancelled.clone();
    view.with_webview(move |native| {
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let core = native.controller().CoreWebView2()?;
                let stream = CreateStreamOnHGlobal(Default::default(), true)?;
                let output = stream.clone();
                let sender = tx.clone();
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &CapturePreviewCompletedHandler::create(Box::new(move |status| {
                        let result = (|| {
                            status?;
                            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                                return Err(windows::core::Error::from_hresult(
                                    windows::core::HRESULT(0x80004004u32 as i32),
                                ));
                            }
                            // Only a marshalled stream reference crosses the UI boundary.
                            // All byte copying, decoding, scaling and encoding run on the worker.
                            windows::core::AgileReference::new(&output)
                        })()
                        .map_err(|_| evidence::error("SCREEN_CAPTURE_FAILED"));
                        let _ = sender.send(result);
                        Ok(())
                    })),
                )?;
                Ok(())
            }
        })();
        if result.is_err() {
            let _ = tx.send(Err(evidence::error("SCREEN_CAPTURE_FAILED")));
        }
    })
    .map_err(|_| evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))?;
    let stream = receive(rx, permit, deadline)??;
    let result = (|| -> windows::core::Result<Vec<u8>> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe {
                        CoUninitialize();
                    }
                }
            }
            let _apartment = Apartment;
            let stream = stream.resolve()?;
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME)?;
            if stat.cbSize > 32 * 1024 * 1024 {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80004005u32 as i32,
                )));
            }
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut bytes = vec![0u8; stat.cbSize as usize];
            let mut read = 0;
            stream
                .Read(
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut read),
                )
                .ok()?;
            bytes.truncate(read as usize);
            Ok(bytes)
        }
    })();
    check(permit, deadline)?;
    result.map_err(|_| evidence::error("SCREEN_CAPTURE_FAILED"))
}
#[cfg(not(windows))]
fn native_capture(_: &tauri::Webview, _: &SupportPermit, _: Instant) -> Result<Vec<u8>, String> {
    Err(evidence::error("SCREEN_CAPTURE_UNAVAILABLE"))
}
pub fn encode(
    image: image::DynamicImage,
    max_edge: u32,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<Value, String> {
    check(permit, deadline)?;
    let edge = max_edge.min(image.width().max(image.height()));
    let mut pixels = image
        .resize(edge, edge, image::imageops::FilterType::Triangle)
        .to_rgb8();
    for _ in 0..8 {
        for quality in [85, 70, 50, 30] {
            check(permit, deadline)?;
            let mut bytes = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
                .encode_image(&pixels)
                .map_err(|_| evidence::error("SCREEN_CAPTURE_FAILED"))?;
            check(permit, deadline)?;
            if bytes.len() <= contracts::cap("screenshot", "imageBytes") as usize
                && jpeg_dimensions(&bytes) == Some((pixels.width(), pixels.height()))
            {
                return Ok(
                    json!({"mime_type":"image/jpeg","width":pixels.width(),"height":pixels.height(),"byte_size":bytes.len(),"sha256":contracts::sha256(&bytes),"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                );
            }
        }
        pixels = image::imageops::resize(
            &pixels,
            (pixels.width() * 3 / 4).max(1),
            (pixels.height() * 3 / 4).max(1),
            image::imageops::FilterType::Triangle,
        );
    }
    Err(evidence::error("SCREEN_CAPTURE_FAILED"))
}
/// Port of the ingress marker walk, including post-scan segments and EOI.
pub fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] || bytes[bytes.len() - 2..] != [0xff, 0xd9] {
        return None;
    }
    let mut offset = 2;
    let mut dimensions = None;
    let mut scanned = false;
    while offset + 2 <= bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        offset += 1;
        let marker = bytes[offset];
        offset += 1;
        if marker == 0xd9 {
            return if scanned && offset == bytes.len() {
                dimensions
            } else {
                None
            };
        }
        if marker == 0xff {
            offset -= 1;
            continue;
        }
        if ![0xc0, 0xc2, 0xc4, 0xda, 0xdb, 0xdd, 0xe0].contains(&marker) || offset + 2 > bytes.len()
        {
            return None;
        }
        let length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        if length < 2 || offset + length > bytes.len() {
            return None;
        }
        if marker == 0xe0
            && (length != 16
                || &bytes[offset + 2..offset + 7] != b"JFIF\0"
                || bytes[offset + 14] != 0
                || bytes[offset + 15] != 0)
        {
            return None;
        }
        if marker == 0xc0 || marker == 0xc2 {
            if length < 8 || dimensions.is_some() {
                return None;
            }
            dimensions = Some((
                u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32,
                u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u32,
            ));
        }
        offset += length;
        if marker == 0xda {
            if dimensions.is_none() {
                return None;
            }
            scanned = true;
            while offset + 1 < bytes.len() {
                if bytes[offset] != 0xff {
                    offset += 1;
                    continue;
                }
                let next = bytes[offset + 1];
                if next == 0 || (0xd0..=0xd7).contains(&next) {
                    offset += 2;
                    continue;
                }
                if next == 0xff {
                    offset += 1;
                    continue;
                }
                break;
            }
        }
    }
    None
}
