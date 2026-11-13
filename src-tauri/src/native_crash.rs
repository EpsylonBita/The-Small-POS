//! Records a native crash to `{log_dir}/crash.log` before Windows ends the process.
//!
//! `panic_hook` covers Rust panics. A fault that is not a panic (an illegal instruction, an
//! access violation nothing handles) used to end the process with an exit code and no trace.
//! On 11/11/2026 the dev till died twice with `0xC000001D` and nothing could say where, or
//! even whether the fault was in this program or in the machine.
//!
//! What is recorded: the exception code, the faulting address as `module+offset`, the bytes at
//! that address (for an illegal instruction this tells a deliberate trap in compiled code,
//! `0f 0b`, from a valid instruction the processor failed to run), and the stack as
//! `module+offset` frames. A debug build, or `RUST_BACKTRACE`, adds the function names.
//! Only module file names and function names are written, never full paths.
//!
//! The exception then continues exactly as before: this never handles, hides or delays a
//! crash, and it changes no exit code.
//!
//! The handler runs in a process that is already broken, so it writes in stages and flushes
//! each one (a later stage that faults cannot lose the earlier ones), records one crash per
//! process, and does the least for a stack overflow, where almost no stack is left.

// The formatting helpers are used by the Windows handlers only; other targets compile them for
// the tests and for `log_last_record`.
#![cfg_attr(not(windows), allow(dead_code))]

/// Marks a native crash record in `crash.log`; `panic_hook` writes `----- PANIC`.
pub const RECORD_MARKER: &str = "----- NATIVE CRASH";

const ILLEGAL_INSTRUCTION: u32 = 0xC000_001D;
const PRIVILEGED_INSTRUCTION: u32 = 0xC000_0096;
const ACCESS_VIOLATION: u32 = 0xC000_0005;
const IN_PAGE_ERROR: u32 = 0xC000_0006;
const STACK_OVERFLOW: u32 = 0xC000_00FD;

/// Plain name of an exception code, for the record's first line.
pub fn code_name(code: u32) -> &'static str {
    match code {
        ILLEGAL_INSTRUCTION => "illegal instruction",
        PRIVILEGED_INSTRUCTION => "privileged instruction",
        ACCESS_VIOLATION => "access violation",
        IN_PAGE_ERROR => "in-page error",
        STACK_OVERFLOW => "stack overflow",
        0xC000_0094 => "integer divide by zero",
        0xC000_0374 => "heap corruption",
        0xC000_0409 => "fast fail",
        0xE06D_7363 => "C++ exception",
        0x8000_0003 => "breakpoint",
        _ => "exception",
    }
}

/// What the faulting bytes of an illegal instruction say about the cause.
pub fn instruction_hint(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x0f, 0x0b, ..] => {
            "ud2: a deliberate trap in compiled code (an abort or an impossible branch)"
        }
        [0x62, ..] => {
            "an EVEX (AVX-512) instruction: the code needs a processor feature this one may lack"
        }
        [] => "the bytes could not be read",
        _ => "not a trap: compare with the processor's features, or suspect the machine",
    }
}

/// Bytes from `address` to the end of its 4 KiB page.
pub fn bytes_left_in_page(address: usize) -> usize {
    const PAGE: usize = 4096;
    PAGE - (address % PAGE)
}

/// The function names of a backtrace, without the source locations: those are full paths.
pub fn symbol_lines(backtrace: &str) -> String {
    backtrace
        .lines()
        .filter(|line| !line.trim_start().starts_with("at "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// First line and facts of a record. Pure, so its shape is tested on every platform.
pub fn format_header(
    timestamp: &str,
    version: &str,
    thread: &str,
    stage: &str,
    code: u32,
    location: &str,
    access: Option<&str>,
) -> String {
    let mut out = format!(
        "{RECORD_MARKER} {timestamp} v{version} thread={thread} {stage} -----\n\
         code: {code:#010x} ({name})\n\
         address: {location}\n",
        name = code_name(code),
    );
    if let Some(access) = access {
        out.push_str("access: ");
        out.push_str(access);
        out.push('\n');
    }
    out
}

/// The latest native crash on record, as one line for the day's log.
pub fn last_record_summary(crash_log: &str) -> Option<String> {
    let start = crash_log.rfind(RECORD_MARKER)?;
    let mut lines = crash_log[start..].lines();
    let first = lines.next()?.trim_end_matches('-').trim();
    let facts: Vec<&str> = lines
        .take_while(|line| !line.starts_with("-----"))
        .filter(|line| line.starts_with("code: ") || line.starts_with("address: "))
        .collect();
    Some(format!("{first} | {}", facts.join(" | ")))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::fmt::Write as _;
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    #[repr(C)]
    pub(super) struct ExceptionRecord {
        code: u32,
        flags: u32,
        chained: *mut ExceptionRecord,
        address: *mut c_void,
        parameter_count: u32,
        parameters: [usize; 15],
    }

    #[repr(C)]
    pub(super) struct ExceptionPointers {
        record: *mut ExceptionRecord,
        context: *mut c_void,
    }

    type Handler = unsafe extern "system" fn(*mut ExceptionPointers) -> i32;

    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
    const GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT: u32 = 0x2;
    const GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS: u32 = 0x4;
    const MAX_FRAMES: usize = 48;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn AddVectoredExceptionHandler(first: u32, handler: Option<Handler>) -> *mut c_void;
        fn SetUnhandledExceptionFilter(filter: Option<Handler>) -> Option<Handler>;
        fn GetModuleHandleExW(flags: u32, address: *const u16, module: *mut *mut c_void) -> i32;
        fn GetModuleFileNameW(module: *mut c_void, name: *mut u16, size: u32) -> u32;
        fn RtlCaptureStackBackTrace(
            skip: u32,
            count: u32,
            frames: *mut *mut c_void,
            hash: *mut u32,
        ) -> u16;
    }

    static CRASH_LOG: OnceLock<PathBuf> = OnceLock::new();
    static PREVIOUS_FILTER: OnceLock<Option<Handler>> = OnceLock::new();
    static RECORDED: AtomicBool = AtomicBool::new(false);

    pub fn install() {
        let crash_log = crate::diagnostics::get_log_dir().join("crash.log");
        if CRASH_LOG.set(crash_log).is_err() {
            return;
        }
        // SAFETY: both handlers are `extern "system"` functions that live for the whole
        // process, and installing them has no other precondition.
        unsafe {
            AddVectoredExceptionHandler(1, Some(first_chance));
            let _ = PREVIOUS_FILTER.set(SetUnhandledExceptionFilter(Some(unhandled)));
        }
    }

    /// First chance: only the two codes that nothing in this process ever handles. Other
    /// first-chance exceptions (C++ exceptions inside the webview, probed reads) are routine.
    unsafe extern "system" fn first_chance(pointers: *mut ExceptionPointers) -> i32 {
        // SAFETY: Windows passes valid pointers for the duration of the call; both are checked.
        let code = unsafe { exception_code(pointers) };
        if matches!(code, Some(ILLEGAL_INSTRUCTION | PRIVILEGED_INSTRUCTION)) {
            // SAFETY: as above.
            unsafe { record(pointers, "first-chance") };
        }
        EXCEPTION_CONTINUE_SEARCH
    }

    /// Last chance: whatever nothing handled. Then the filter that was there before decides,
    /// as it always did.
    unsafe extern "system" fn unhandled(pointers: *mut ExceptionPointers) -> i32 {
        // SAFETY: Windows passes valid pointers for the duration of the call; both are checked.
        unsafe { record(pointers, "unhandled") };
        match PREVIOUS_FILTER.get().copied().flatten() {
            // SAFETY: the previous filter was installed by the runtime with this signature.
            Some(previous) => unsafe { previous(pointers) },
            None => EXCEPTION_CONTINUE_SEARCH,
        }
    }

    unsafe fn exception_code(pointers: *mut ExceptionPointers) -> Option<u32> {
        if pointers.is_null() {
            return None;
        }
        // SAFETY: `pointers` is non-null and valid for the call.
        let record = unsafe { (*pointers).record };
        if record.is_null() {
            return None;
        }
        // SAFETY: `record` is non-null and valid for the call.
        Some(unsafe { (*record).code })
    }

    unsafe fn record(pointers: *mut ExceptionPointers, stage: &str) {
        if pointers.is_null() || RECORDED.swap(true, Ordering::SeqCst) {
            return;
        }
        // SAFETY: `pointers` is non-null and valid for the call.
        let record = unsafe { (*pointers).record };
        if record.is_null() {
            return;
        }
        // SAFETY: `record` is non-null and valid for the call.
        let (code, address, count, parameters) = unsafe {
            (
                (*record).code,
                (*record).address as usize,
                (*record).parameter_count as usize,
                (*record).parameters,
            )
        };

        // Stage 1: the facts that cost nothing.
        let access = (matches!(code, ACCESS_VIOLATION | IN_PAGE_ERROR) && count >= 2).then(|| {
            let kind = match parameters[0] {
                0 => "read of",
                1 => "write to",
                8 => "execution of",
                _ => "access to",
            };
            format!("{kind} {:#018x}", parameters[1])
        });
        let thread = std::thread::current();
        write_stage(&format_header(
            &chrono::Utc::now().to_rfc3339(),
            env!("CARGO_PKG_VERSION"),
            thread.name().unwrap_or("<unnamed>"),
            stage,
            code,
            &describe_address(address),
            access.as_deref(),
        ));
        if code == STACK_OVERFLOW {
            return;
        }

        // Stage 2: what the processor refused to run. Code pages are readable.
        if matches!(code, ILLEGAL_INSTRUCTION | PRIVILEGED_INSTRUCTION) && address != 0 {
            let mut bytes = [0u8; 16];
            // Never past the end of the faulting page: the next one may not be mapped, and a
            // second fault here would end the process with a different code.
            let length = bytes.len().min(bytes_left_in_page(address));
            // SAFETY: the address faulted on execution, so its page is mapped and readable
            // code, and `length` stays inside that page and inside the buffer.
            unsafe {
                std::ptr::copy_nonoverlapping(address as *const u8, bytes.as_mut_ptr(), length)
            };
            write_stage(&format!(
                "bytes: {}\nhint: {}\n",
                hex_bytes(&bytes[..length]),
                instruction_hint(&bytes[..length])
            ));
        }

        // Stage 3: the stack as module+offset, with no symbol lookup and no symbol lock.
        let mut frames = [std::ptr::null_mut::<c_void>(); MAX_FRAMES];
        // SAFETY: the buffer holds MAX_FRAMES entries and the hash pointer may be null.
        let captured = unsafe {
            RtlCaptureStackBackTrace(
                0,
                MAX_FRAMES as u32,
                frames.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        } as usize;
        let mut stack = String::from("frames:\n");
        for (index, frame) in frames.iter().take(captured.min(MAX_FRAMES)).enumerate() {
            let _ = writeln!(stack, "  {index:>2}: {}", describe_address(*frame as usize));
        }
        write_stage(&stack);

        // Stage 4: names, where symbols exist and a slow or stuck lookup costs nothing.
        if cfg!(debug_assertions) || std::env::var_os("RUST_BACKTRACE").is_some() {
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            write_stage(&format!("backtrace:\n{}\n", symbol_lines(&backtrace)));
        }
    }

    /// `module.dll+0x1234`, or the bare address when no module owns it.
    fn describe_address(address: usize) -> String {
        let mut module = std::ptr::null_mut::<c_void>();
        // SAFETY: FROM_ADDRESS makes the second argument an address, not a string, and
        // UNCHANGED_REFCOUNT means there is nothing to release.
        let found = unsafe {
            GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                    | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                address as *const u16,
                &mut module,
            )
        };
        if found == 0 || module.is_null() {
            return format!("{address:#018x} (no module)");
        }
        let mut name = [0u16; 512];
        // SAFETY: the buffer is 512 UTF-16 units and that size is passed.
        let length = unsafe { GetModuleFileNameW(module, name.as_mut_ptr(), name.len() as u32) };
        let full = String::from_utf16_lossy(&name[..(length as usize).min(name.len())]);
        // The file name only: the folder holds the Windows user name.
        let file = full.rsplit(['\\', '/']).next().unwrap_or("<module>");
        format!("{file}+{:#x}", address.wrapping_sub(module as usize))
    }

    /// Best effort and flushed: the next stage may never run. Nothing here may panic, so the
    /// console copy does not go through `eprint!`.
    fn write_stage(text: &str) {
        let _ = std::io::stderr().write_all(text.as_bytes());
        let Some(path) = CRASH_LOG.get() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(text.as_bytes());
            let _ = file.flush();
            let _ = file.sync_data();
        }
    }
}

/// Install the recorder. Call once, right after `panic_hook::install()`.
pub fn install() {
    #[cfg(windows)]
    imp::install();
}

/// One line in the day's log about the latest native crash on record, so support sees it
/// without opening `crash.log`. Nothing is logged when there is none.
pub fn log_last_record() {
    use std::io::{Read, Seek, SeekFrom};

    // The tail is enough, and a long history must not slow the start.
    const TAIL: u64 = 64 * 1024;
    let path = crate::diagnostics::get_log_dir().join("crash.log");
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if file
        .seek(SeekFrom::Start(length.saturating_sub(TAIL)))
        .is_err()
    {
        return;
    }
    let mut tail = Vec::new();
    if file.take(TAIL).read_to_end(&mut tail).is_err() {
        return;
    }
    if let Some(summary) = last_record_summary(&String::from_utf8_lossy(&tail)) {
        tracing::warn!(target: "native_crash", "LAST_NATIVE_CRASH_ON_RECORD {summary}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_codes_a_till_can_die_with() {
        assert_eq!(code_name(0xC000_001D), "illegal instruction");
        assert_eq!(code_name(0xC000_0005), "access violation");
        assert_eq!(code_name(0xC000_00FD), "stack overflow");
        assert_eq!(code_name(0x1234_5678), "exception");
    }

    #[test]
    fn tells_a_trap_from_an_instruction_the_processor_refused() {
        assert!(instruction_hint(&[0x0f, 0x0b, 0x90]).starts_with("ud2"));
        assert!(instruction_hint(&[0x62, 0xf1, 0x7c]).contains("AVX-512"));
        assert!(instruction_hint(&[0x48, 0x89, 0xe5]).contains("suspect the machine"));
        assert_eq!(instruction_hint(&[]), "the bytes could not be read");
        assert_eq!(hex_bytes(&[0x0f, 0x0b, 0xff]), "0f 0b ff");
        // The read of the faulting bytes never crosses into the next page.
        assert_eq!(bytes_left_in_page(0x7ff6_0000_1000), 4096);
        assert_eq!(bytes_left_in_page(0x7ff6_0000_1ffe), 2);
        assert_eq!(bytes_left_in_page(0x7ff6_0000_1fff), 1);
    }

    #[test]
    fn backtrace_keeps_names_and_drops_source_paths() {
        let backtrace = [
            "   0: the_small_pos_lib::sync::run",
            "             at C:/Users/someone/src/sync.rs:10",
            "   1: <unknown>",
        ]
        .join("\n");
        assert_eq!(
            symbol_lines(&backtrace),
            "   0: the_small_pos_lib::sync::run\n   1: <unknown>"
        );
    }

    #[test]
    fn header_carries_code_place_and_access_and_no_path() {
        let header = format_header(
            "2026-11-11T14:40:54+00:00",
            "1.4.144",
            "tokio-runtime-worker",
            "first-chance",
            0xC000_001D,
            "the-small-pos.exe+0x1a2b3c",
            None,
        );
        assert_eq!(
            header,
            "----- NATIVE CRASH 2026-11-11T14:40:54+00:00 v1.4.144 thread=tokio-runtime-worker first-chance -----\n\
             code: 0xc000001d (illegal instruction)\n\
             address: the-small-pos.exe+0x1a2b3c\n"
        );
        let with_access = format_header(
            "t",
            "v",
            "main",
            "unhandled",
            0xC000_0005,
            "x.dll+0x10",
            Some("read of 0x0000000000000008"),
        );
        assert!(with_access.ends_with("access: read of 0x0000000000000008\n"));
        assert!(!with_access.contains('\\'));
    }

    #[test]
    fn summarises_only_the_latest_native_crash() {
        let log = "----- PANIC 2026-11-04T11:19:03+00:00 v1.4.126 thread=main at app.rs:1:1 -----\n\
                   message: boom\n\
                   ----- NATIVE CRASH 2026-11-10T08:00:00+00:00 v1.4.143 thread=main unhandled -----\n\
                   code: 0xc0000005 (access violation)\n\
                   address: old.dll+0x1\n\
                   ----- NATIVE CRASH 2026-11-11T14:40:54+00:00 v1.4.144 thread=main first-chance -----\n\
                   code: 0xc000001d (illegal instruction)\n\
                   address: the-small-pos.exe+0x1a2b3c\n\
                   bytes: 0f 0b\n";
        assert_eq!(
            last_record_summary(log).as_deref(),
            Some(
                "----- NATIVE CRASH 2026-11-11T14:40:54+00:00 v1.4.144 thread=main first-chance | \
                 code: 0xc000001d (illegal instruction) | address: the-small-pos.exe+0x1a2b3c"
            )
        );
        assert_eq!(
            last_record_summary("----- PANIC only -----\nmessage: boom\n"),
            None
        );
        assert_eq!(last_record_summary(""), None);
    }

    /// The symptom of 11/11/2026, reproduced: a process that executes an illegal instruction
    /// still dies with 0xC000001D, and now leaves the place and the bytes behind.
    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn records_an_illegal_instruction_before_the_process_dies() {
        const CHILD: &str = "THE_SMALL_NATIVE_CRASH_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn SetErrorMode(mode: u32) -> u32;
            }
            // No "has stopped working" window from a test.
            // SAFETY: plain flags; SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX.
            unsafe { SetErrorMode(0x0001 | 0x0002) };
            install();
            // SAFETY: the point of the test is to execute an instruction the processor refuses.
            unsafe { core::arch::asm!("ud2") };
            unreachable!("ud2 does not return");
        }

        let dir =
            std::env::temp_dir().join(format!("thesmall-native-crash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let status = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "native_crash::tests::records_an_illegal_instruction_before_the_process_dies",
                "--test-threads=1",
            ])
            .env(CHILD, "1")
            // The log directory is derived from LOCALAPPDATA: keep the real one clean.
            .env("LOCALAPPDATA", &dir)
            .env_remove("RUST_BACKTRACE")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("child test process");
        // The crash is recorded, never swallowed: Windows still ends the process with the code.
        assert_eq!(status.code().map(|code| code as u32), Some(0xC000_001D));

        // The child derived its log folder from LOCALAPPDATA: find the file under it.
        fn find_crash_log(folder: &std::path::Path) -> Option<std::path::PathBuf> {
            for entry in std::fs::read_dir(folder).ok()?.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(found) = find_crash_log(&path) {
                        return Some(found);
                    }
                } else if path.file_name().is_some_and(|name| name == "crash.log") {
                    return Some(path);
                }
            }
            None
        }
        let log_path = find_crash_log(&dir).expect("crash.log written by the child");
        let log = std::fs::read_to_string(&log_path).expect("readable crash.log");
        assert!(log.contains("----- NATIVE CRASH "), "{log}");
        assert!(log.contains(" first-chance -----"), "{log}");
        assert!(
            log.contains("code: 0xc000001d (illegal instruction)"),
            "{log}"
        );
        assert!(log.contains("bytes: 0f 0b"), "{log}");
        assert!(log.contains("hint: ud2"), "{log}");
        assert!(log.contains("frames:\n"), "{log}");
        // The place is the test binary itself, by file name only.
        let exe = std::env::current_exe().expect("test binary");
        let exe_name = exe
            .file_name()
            .and_then(|name| name.to_str())
            .expect("file name");
        assert!(log.contains(&format!("address: {exe_name}+0x")), "{log}");
        assert!(!log.contains(":\\"), "no full path may be written: {log}");
        // Recorded once, although both handlers saw it.
        assert_eq!(log.matches("----- NATIVE CRASH ").count(), 1, "{log}");
        assert!(last_record_summary(&log).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
