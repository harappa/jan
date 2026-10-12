//! Running one python script in an MXC process container: output capture, the
//! time and disk limits, cancelling, and the result text the model reads.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mxc_sdk::v1::{self, MxcProcess, SpawnOptions, StreamCloser, TelemetryConfig, WaitResult};

use super::availability::{self, PythonStatus};
use super::request::{build_request, RunSpec, MAX_TIMEOUT_S};
use super::snapshot::{changed, snapshot, total_size, ChangedFile, MAX_LISTED_FILES};
use crate::tools::handlers::BashCapture;

/// A run is stopped once the workspace has grown by more than this since it started.
pub const DISK_LIMIT_BYTES: u64 = 1 << 30;
/// The longest gap between two measurements of the workspace size while a run
/// is going. Small workspaces are measured more often (see `measure_gap`).
pub const POLL_MS: u64 = 500;

/// How often the process is checked for exit, and the shortest gap between two
/// workspace measurements. Shorter than `POLL_MS` so a quick script does not
/// wait out a whole disk-check interval before returning.
const EXIT_POLL: Duration = Duration::from_millis(20);
/// Measuring the workspace may take up to 1/`MEASURE_SHARE` of the run's time.
const MEASURE_SHARE: u32 = 10;
/// How long a killed process may take to be seen as gone before giving up on it.
const KILL_GRACE: Duration = Duration::from_secs(10);
/// How long the output readers get to reach the end of the pipes once the
/// process is gone, before their reads are cut short.
const READER_GRACE: Duration = Duration::from_secs(2);

const ALREADY_RUNNING: &str = "a python run is already in progress in this chat";
const CANCELLED: &str = "the python run was cancelled";

/// What a run hands back: the text for the model, and whether it failed.
#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    /// Output, `[exit N]`, then the markers (`[file: ...]` lines list the files
    /// the run created or changed).
    pub content: String,
    /// True when the exit code was not 0, the run timed out, it was stopped by
    /// the disk limit, or it was cancelled.
    pub is_error: bool,
}

/// One chat's claim on running python. Held from before the inputs are staged
/// until the run ends; dropping it releases the chat and kills a process that is
/// still running (the tool call was abandoned).
#[must_use = "the chat is free to run again as soon as the guard is dropped"]
pub struct RunGuard {
    thread_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let slot = registry().remove(&self.thread_id);
        if let Some(process) = slot.and_then(|s| s.process) {
            let _ = lock(&process).kill();
        }
    }
}

/// The run registered for one chat.
#[derive(Default)]
struct Slot {
    /// Set while the sandboxed process exists, so `cancel` can kill it.
    process: Option<Arc<Mutex<MxcProcess>>>,
    /// `cancel` was called for this run.
    cancelled: bool,
}

fn registry() -> MutexGuard<'static, HashMap<String, Slot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    lock(REGISTRY.get_or_init(Default::default))
}

/// A poisoned lock only means another run panicked; the data is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Claim the chat for one run. A second claim while one is held is refused at
/// once rather than queued.
pub fn begin_run(thread_id: &str) -> Result<RunGuard, String> {
    let mut runs = registry();
    if runs.contains_key(thread_id) {
        return Err(ALREADY_RUNNING.to_string());
    }
    runs.insert(thread_id.to_string(), Slot::default());
    Ok(RunGuard {
        thread_id: thread_id.to_string(),
    })
}

/// Stop the chat's run: kill its process if it has started, or keep it from
/// starting. True when the chat had a run to stop.
pub fn cancel(thread_id: &str) -> bool {
    let process = {
        let mut runs = registry();
        let Some(slot) = runs.get_mut(thread_id) else {
            return false;
        };
        slot.cancelled = true;
        slot.process.clone()
    };
    if let Some(process) = process {
        let _ = lock(&process).kill();
    }
    true
}

fn is_cancelled(thread_id: &str) -> bool {
    registry().get(thread_id).is_some_and(|s| s.cancelled)
}

/// Make the process reachable by `cancel`. True when a cancel already came in.
fn attach(thread_id: &str, process: &Arc<Mutex<MxcProcess>>) -> bool {
    let mut runs = registry();
    let slot = runs.entry(thread_id.to_string()).or_default();
    slot.process = Some(Arc::clone(process));
    slot.cancelled
}

/// Forget the (finished) process. Returns whether the run was cancelled.
fn detach(thread_id: &str) -> bool {
    let mut runs = registry();
    match runs.get_mut(thread_id) {
        Some(slot) => {
            slot.process = None;
            slot.cancelled
        }
        None => false,
    }
}

/// Run `code` in the sandbox described by `spec`, for the chat `guard` holds.
///
/// Refuses (without spawning) unless the sandbox is available: MXC 1.0.0 cannot
/// be told not to fall back to rewriting folder ACLs, so the availability check
/// is what keeps a host without BaseContainer from having its ACLs changed.
///
/// `skipped` are the attachments staging left out, listed in the result.
pub async fn run_python(
    spec: RunSpec,
    guard: &RunGuard,
    code: &str,
    skipped: &[(String, String)],
) -> Result<RunOutcome, String> {
    run_python_checked(spec, guard, code, skipped, availability::status).await
}

/// `run_python` with the availability check passed in (a seam for tests).
async fn run_python_checked(
    spec: RunSpec,
    guard: &RunGuard,
    code: &str,
    skipped: &[(String, String)],
    status: fn() -> PythonStatus,
) -> Result<RunOutcome, String> {
    let thread_id = guard.thread_id.clone();
    let code = code.to_string();
    let skipped = skipped.to_vec();
    // Everything below blocks: the first availability check probes MXC, and the
    // snapshots, the spawn, the pipes and the waits are all synchronous.
    tokio::task::spawn_blocking(move || {
        let status = status();
        if !status.available {
            return Err(format!(
                "python is not available on this machine: {}",
                status.reason.as_deref().unwrap_or("unknown reason")
            ));
        }
        run_blocking(&spec, &thread_id, &code, &skipped)
    })
    .await
    .map_err(|e| format!("the python run failed: {e}"))?
}

/// How the watch over a running process ended.
#[derive(Default)]
struct Watch {
    timed_out: bool,
    disk_stopped: bool,
    /// The process could not be checked or stopped.
    error: Option<String>,
}

fn run_blocking(
    spec: &RunSpec,
    thread_id: &str,
    code: &str,
    skipped: &[(String, String)],
) -> Result<RunOutcome, String> {
    if is_cancelled(thread_id) {
        return Err(CANCELLED.to_string());
    }
    let before =
        snapshot(&spec.workspace).map_err(|e| format!("cannot read the python workspace: {e}"))?;
    let before_size = total_size(&before);
    let started = Instant::now();

    let options = SpawnOptions {
        telemetry: Some(TelemetryConfig {
            enabled: Some(false),
        }),
    };
    let mut process = v1::spawn(build_request(spec), options).map_err(|e| {
        log_failure(
            thread_id,
            started,
            format!("cannot start python in the sandbox: {e}"),
        )
    })?;
    if let Err(e) = lower_priority(process.id()) {
        eprintln!("python run: could not lower the priority ({e}); continuing");
    }
    // The timeout is the script's own time, so it counts from the spawn.
    let deadline = Instant::now() + Duration::from_secs(u64::from(spec.timeout_s));

    let stdin = process.take_stdin();
    let closers: Vec<StreamCloser> = [process.stdout_closer(), process.stderr_closer()]
        .into_iter()
        .flatten()
        .collect();
    let streams = [process.take_stdout(), process.take_stderr()];
    let process = Arc::new(Mutex::new(process));
    if attach(thread_id, &process) {
        // Cancelled between the check above and the spawn.
        let _ = lock(&process).kill();
    }

    let capture = Arc::new(Mutex::new(BashCapture::new(None)));
    let output_bytes = Arc::new(AtomicU64::new(0));
    let (done_tx, done_rx) = mpsc::channel();
    let readers: Vec<JoinHandle<()>> = streams
        .into_iter()
        .flatten()
        .map(|stream| {
            spawn_reader(
                stream,
                Arc::clone(&capture),
                Arc::clone(&output_bytes),
                done_tx.clone(),
            )
        })
        .collect();
    drop(done_tx);
    // On its own thread: a script that never reads stdin must not hold up the
    // deadline. Dropping the writer closes stdin, which ends the script.
    let writer = stdin.map(|mut w| {
        let code = code.to_string();
        std::thread::spawn(move || {
            let _ = w.write_all(code.as_bytes());
            let _ = w.flush();
        })
    });

    let watch = watch(&process, &spec.workspace, before_size, deadline);
    let waited = if watch.error.is_some() {
        // Not known to be gone: `wait` could block for the whole timeout, and
        // dropping the handle kills the tree anyway.
        None
    } else {
        Some(lock(&process).wait())
    };
    let cancelled = detach(thread_id);
    drop(process);

    // The tree is dead, so the pipes are closed and the readers reach their
    // end; cut the reads short only if something still holds a pipe open.
    for _ in 0..readers.len() {
        if done_rx.recv_timeout(READER_GRACE).is_err() {
            closers.iter().for_each(StreamCloser::close);
            break;
        }
    }
    for reader in readers {
        let _ = reader.join();
    }
    if let Some(writer) = writer {
        let _ = writer.join();
    }

    if let Some(error) = watch.error {
        let error = format!("the python run failed: {error}");
        return Err(log_failure(thread_id, started, error));
    }
    let mut timed_out = watch.timed_out;
    let code = match waited {
        Some(Ok(WaitResult::Exited(code))) if !timed_out => Some(code),
        Some(Ok(WaitResult::Exited(_))) => None,
        Some(Ok(WaitResult::TimedOut)) => {
            timed_out = true;
            None
        }
        Some(Err(e)) => {
            let error = format!("the python run failed: {e}");
            return Err(log_failure(thread_id, started, error));
        }
        None => None,
    };

    let capture = Arc::try_unwrap(capture)
        .map_err(|_| "the python output is still being read".to_string())?
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner);
    let captured = capture.finish(code);
    // The run may have removed the workspace; then there is nothing to list.
    let after = snapshot(&spec.workspace).unwrap_or_default();
    let files = changed(&before, &after);
    let content = format_result(
        captured,
        timed_out.then_some(spec.timeout_s),
        watch.disk_stopped,
        skipped,
        &files,
    );
    let outcome = RunOutcome {
        content,
        is_error: code != Some(0) || timed_out || watch.disk_stopped || cancelled,
    };
    log_run(&RunLog {
        thread_id,
        took: started.elapsed(),
        code,
        timed_out,
        disk_stopped: watch.disk_stopped,
        cancelled,
        output_bytes: output_bytes.load(Ordering::Relaxed),
    });
    Ok(outcome)
}

/// Read one of the process's pipes into the shared capture until it ends.
fn spawn_reader(
    mut stream: Box<dyn Read + Send>,
    capture: Arc<Mutex<BashCapture>>,
    output_bytes: Arc<AtomicU64>,
    done: mpsc::Sender<()>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    output_bytes.fetch_add(n as u64, Ordering::Relaxed);
                    lock(&capture).push(&buf[..n]);
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = done.send(());
    })
}

/// How many bytes the workspace has grown by since it held `before_size`.
///
/// Unreadable parts of the folder are skipped, and an unreadable root counts as
/// no growth: the check must not stop a run by mistake.
///
/// On Windows a folder listing gives each file's size as its directory entry
/// last recorded it, and NTFS updates that for a file open for writing only
/// when it is closed: a script writing 2 GiB through one handle was listed at
/// 0 bytes throughout. So there each file's size is read from the file itself
/// (`symlink_metadata` opens it without following links). Unix listings are
/// already exact.
fn grown_since(workspace: &Path, before_size: u64) -> u64 {
    let Ok(listed) = snapshot(workspace) else {
        return 0;
    };
    let now = if cfg!(windows) {
        listed
            .iter()
            .map(|(rel, (size, _))| {
                std::fs::symlink_metadata(workspace.join(rel)).map_or(*size, |m| m.len())
            })
            .sum()
    } else {
        total_size(&listed)
    };
    now.saturating_sub(before_size)
}

/// The pause before the next workspace measurement, given how long the last one
/// took: walking gets about a tenth of the time, never more than `POLL_MS`
/// apart. A fixed 0.5 s is too coarse: a script can put 2 GB into the page cache
/// in well under a second, before a fixed check would first look.
fn measure_gap(walk: Duration) -> Duration {
    (walk * MEASURE_SHARE).clamp(EXIT_POLL, Duration::from_millis(POLL_MS))
}

/// Wait for the process to end, enforcing the deadline and the disk limit.
///
/// MXC enforces `timeout_ms` only inside `wait` on Windows (its `try_wait`
/// reports a timeout only after `kill_for_timeout`), while Bubblewrap's
/// `try_wait` enforces it itself. So the deadline is kept here too, and a
/// `TimedOut` from `try_wait` is taken as the timeout either way.
fn watch(
    process: &Mutex<MxcProcess>,
    workspace: &Path,
    before_size: u64,
    deadline: Instant,
) -> Watch {
    let mut watch = Watch::default();
    let mut next_measure = Instant::now() + EXIT_POLL;
    let mut killed_at: Option<Instant> = None;
    loop {
        let state = lock(process).try_wait();
        match state {
            Ok(Some(_)) => return watch,
            Ok(None) => {}
            Err(e) if e.kind() == ErrorKind::TimedOut => {
                watch.timed_out = true;
                return watch;
            }
            Err(e) => {
                let _ = lock(process).kill();
                watch.error = Some(format!("cannot check the python process: {e}"));
                return watch;
            }
        }
        let now = Instant::now();
        if let Some(at) = killed_at {
            if now.duration_since(at) >= KILL_GRACE {
                watch.error = Some("the python process did not stop".to_string());
                return watch;
            }
        } else if now >= deadline {
            if let Err(e) = lock(process).kill_for_timeout() {
                watch.error = Some(format!("cannot stop the python process: {e}"));
                return watch;
            }
            watch.timed_out = true;
            killed_at = Some(now);
            continue;
        } else if now >= next_measure {
            let grown = grown_since(workspace, before_size);
            let measured = Instant::now();
            next_measure = measured + measure_gap(measured.duration_since(now));
            if grown > DISK_LIMIT_BYTES {
                if let Err(e) = lock(process).kill() {
                    watch.error = Some(format!("cannot stop the python process: {e}"));
                    return watch;
                }
                watch.disk_stopped = true;
                killed_at = Some(measured);
                continue;
            }
        }
        std::thread::sleep(EXIT_POLL);
    }
}

/// Give the sandboxed process below-normal CPU priority, so a busy script does
/// not slow the app down. Processes it starts inherit the class.
#[cfg(windows)]
fn lower_priority(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };
    // SAFETY: plain Win32 calls on a handle opened and closed here. The pid
    // cannot be reused meanwhile: MXC holds a handle to the process until it is
    // reaped.
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let ok = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
        let error = std::io::Error::last_os_error();
        CloseHandle(handle);
        if ok == 0 {
            return Err(error.to_string());
        }
    }
    Ok(())
}

/// Nice the sandboxed process to 10, so a busy script does not slow the app
/// down. Processes it starts afterwards inherit the value.
#[cfg(unix)]
fn lower_priority(pid: u32) -> Result<(), String> {
    use nix::libc;
    // SAFETY: `setpriority` takes plain integers. The pid cannot be reused
    // meanwhile: the process is not reaped until MXC waits on it.
    let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, 10) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// What is recorded about a run. Never the code or the output.
struct RunLog<'a> {
    thread_id: &'a str,
    took: Duration,
    code: Option<i32>,
    timed_out: bool,
    disk_stopped: bool,
    cancelled: bool,
    output_bytes: u64,
}

/// The plugin has no logging crate; its diagnostics go to stderr.
fn log_run(log: &RunLog<'_>) {
    eprintln!(
        "python run: thread {}, {:.2} s, exit {}, timed out {}, disk stopped {}, \
         cancelled {}, {} output bytes",
        log.thread_id,
        log.took.as_secs_f64(),
        log.code
            .map_or_else(|| "none".to_string(), |c| c.to_string()),
        log.timed_out,
        log.disk_stopped,
        log.cancelled,
        log.output_bytes,
    );
}

/// A run that ended in a tool error. `error` is our own message, never the
/// script's output.
fn log_failure(thread_id: &str, started: Instant, error: String) -> String {
    eprintln!(
        "python run: thread {thread_id}, {:.2} s, failed: {error}",
        started.elapsed().as_secs_f64()
    );
    error
}

/// The text the model reads: the captured output (ending in `[exit N]`), then
/// one line per skipped input, the timeout, the disk stop, and each changed file
/// (at most `MAX_LISTED_FILES`, the rest counted).
pub fn format_result(
    captured: String,
    timed_out: Option<u32>,
    disk_stopped: bool,
    skipped: &[(String, String)],
    files: &[ChangedFile],
) -> String {
    let mut out = captured;
    let mut line = |text: String| {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&text);
    };
    for (name, reason) in skipped {
        line(format!("[input skipped: {name} ({reason})]"));
    }
    if let Some(seconds) = timed_out {
        line(format!(
            "[timed out after {seconds} s: split the work or pass a larger timeout, up to {MAX_TIMEOUT_S}]"
        ));
    }
    if disk_stopped {
        line("[stopped: the run wrote more than 1 GB to the workspace]".to_string());
    }
    for file in files.iter().take(MAX_LISTED_FILES) {
        line(format!("[file: {} ({} bytes)]", file.path, file.size));
    }
    if files.len() > MAX_LISTED_FILES {
        line(format!(
            "[files: {} more not listed]",
            files.len() - MAX_LISTED_FILES
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn file(path: &str, size: u64) -> ChangedFile {
        ChangedFile {
            path: path.to_string(),
            size,
        }
    }

    fn skipped(name: &str, reason: &str) -> (String, String) {
        (name.to_string(), reason.to_string())
    }

    /// A thread id no other test uses, so the shared registry never couples tests.
    fn unique_thread() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!(
            "run-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        )
    }

    #[test]
    fn markers_follow_the_output_in_order() {
        let out = format_result(
            "hello\n[exit 1]".to_string(),
            Some(30),
            true,
            &[skipped("big.bin", "larger than 256 MB")],
            &[file("out.csv", 12)],
        );
        assert_eq!(
            out,
            "hello\n[exit 1]\n\
             [input skipped: big.bin (larger than 256 MB)]\n\
             [timed out after 30 s: split the work or pass a larger timeout, up to 300]\n\
             [stopped: the run wrote more than 1 GB to the workspace]\n\
             [file: out.csv (12 bytes)]"
        );
    }

    #[test]
    fn nothing_to_add_leaves_the_output_alone() {
        assert_eq!(
            format_result("[exit 0]".to_string(), None, false, &[], &[]),
            "[exit 0]"
        );
    }

    #[test]
    fn every_skipped_input_gets_its_own_line_with_the_reason_verbatim() {
        let out = format_result(
            "[exit 0]".to_string(),
            None,
            false,
            &[
                skipped("a.txt", "not found"),
                skipped("b", "invalid file name"),
            ],
            &[],
        );
        assert_eq!(
            out,
            "[exit 0]\n[input skipped: a.txt (not found)]\n[input skipped: b (invalid file name)]"
        );
    }

    #[test]
    fn files_are_listed_up_to_fifty_and_the_rest_counted() {
        let files: Vec<ChangedFile> = (0..53).map(|i| file(&format!("f{i:02}.txt"), i)).collect();
        let out = format_result("[exit 0]".to_string(), None, false, &[], &files);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 1 + 50 + 1);
        assert_eq!(lines[1], "[file: f00.txt (0 bytes)]");
        assert_eq!(lines[50], "[file: f49.txt (49 bytes)]");
        assert_eq!(lines[51], "[files: 3 more not listed]");
        assert!(!out.contains("f50.txt"));
    }

    #[test]
    fn exactly_fifty_files_need_no_count() {
        let files: Vec<ChangedFile> = (0..50).map(|i| file(&format!("f{i}"), 1)).collect();
        let out = format_result("[exit 0]".to_string(), None, false, &[], &files);
        assert_eq!(out.lines().count(), 51);
        assert!(!out.contains("more not listed"));
    }

    #[test]
    fn japanese_paths_are_kept_as_they_are() {
        let out = format_result(
            "[exit 0]".to_string(),
            None,
            false,
            &[],
            &[file("結果/表.csv", 2048)],
        );
        assert_eq!(out, "[exit 0]\n[file: 結果/表.csv (2048 bytes)]");
    }

    #[test]
    fn markers_start_on_a_new_line_after_a_truncation_note() {
        let out = format_result(
            "x\n[exit 0]\n[output truncated at 10 of 99 bytes]".to_string(),
            None,
            true,
            &[],
            &[],
        );
        assert_eq!(
            out,
            "x\n[exit 0]\n[output truncated at 10 of 99 bytes]\n\
             [stopped: the run wrote more than 1 GB to the workspace]"
        );
    }

    #[test]
    fn a_second_run_in_the_same_chat_is_refused_until_the_first_ends() {
        let id = unique_thread();
        let first = begin_run(&id).expect("first run starts");
        assert_eq!(
            begin_run(&id).err().as_deref(),
            Some("a python run is already in progress in this chat")
        );
        drop(first);
        let again = begin_run(&id).expect("free again once the first guard is gone");
        drop(again);
    }

    #[test]
    fn different_chats_run_independently() {
        let a = begin_run(&unique_thread()).expect("a");
        let b = begin_run(&unique_thread()).expect("b");
        drop((a, b));
    }

    #[test]
    fn cancel_reports_whether_a_run_was_active() {
        let id = unique_thread();
        assert!(!cancel(&id));
        let guard = begin_run(&id).unwrap();
        assert!(cancel(&id));
        drop(guard);
        assert!(!cancel(&id));
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// A spec whose workspace does not exist: reaching the snapshot (or the
    /// spawn) would fail with a different error than the one asserted.
    fn missing_spec() -> RunSpec {
        let base = std::env::temp_dir().join(format!("jan_run_missing_{}", unique_thread()));
        RunSpec {
            runtime: base.join("runtime"),
            workspace: base.join("ws"),
            inputs: base.join("in"),
            timeout_s: 1,
        }
    }

    fn unavailable() -> PythonStatus {
        PythonStatus {
            available: false,
            reason: Some("MXC base container would need DACL changes".to_string()),
        }
    }

    fn available() -> PythonStatus {
        PythonStatus {
            available: true,
            reason: None,
        }
    }

    #[test]
    fn refuses_to_spawn_when_the_sandbox_is_unavailable() {
        let id = unique_thread();
        let guard = begin_run(&id).unwrap();
        let spec = missing_spec();
        let err = rt()
            .block_on(run_python_checked(
                spec.clone(),
                &guard,
                "print(1)",
                &[],
                unavailable,
            ))
            .expect_err("must refuse");
        assert_eq!(
            err,
            "python is not available on this machine: MXC base container would need DACL changes"
        );
        assert!(!spec.workspace.exists());
    }

    #[test]
    fn a_run_cancelled_before_it_starts_never_spawns() {
        let id = unique_thread();
        let guard = begin_run(&id).unwrap();
        assert!(cancel(&id));
        let err = rt()
            .block_on(run_python_checked(
                missing_spec(),
                &guard,
                "print(1)",
                &[],
                available,
            ))
            .expect_err("cancelled");
        assert_eq!(err, "the python run was cancelled");
    }

    /// A scratch folder under the host temp dir, removed on drop.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("jan_run_scratch_{}", unique_thread()));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Windows lists a file still open for writing at the size its directory
    /// entry last had (0 for a new file) until it is closed. The disk check must
    /// see the bytes anyway, or one long write would get past the limit.
    #[test]
    fn growth_counts_a_file_that_is_still_being_written() {
        use std::io::Write;
        let dir = Scratch::new();
        std::fs::write(dir.0.join("old.txt"), b"12345").unwrap();
        let before = total_size(&snapshot(&dir.0).unwrap());
        assert_eq!(before, 5);

        let mut open = std::fs::File::create(dir.0.join("big.bin")).unwrap();
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..8 {
            open.write_all(&chunk).unwrap();
        }
        assert_eq!(grown_since(&dir.0, before), 8 << 20);
        drop(open);
        assert_eq!(grown_since(&dir.0, before), 8 << 20);
    }

    /// Reading every file's size costs more than the listing on Windows;
    /// `measure_gap` spaces the checks out by it. Printed for the record.
    #[test]
    fn growth_of_ten_thousand_files_is_measured() {
        let dir = Scratch::new();
        for i in 0..100 {
            let sub = dir.0.join(format!("d{i}"));
            std::fs::create_dir(&sub).unwrap();
            for j in 0..100 {
                std::fs::write(sub.join(format!("f{j}")), b"x").unwrap();
            }
        }
        let started = std::time::Instant::now();
        assert_eq!(grown_since(&dir.0, 0), 10_000);
        let took = started.elapsed();
        println!("growth of 10000 files measured in {took:?}");
        assert!(took < Duration::from_secs(30));
    }

    #[test]
    fn growth_is_zero_for_a_missing_folder_or_a_shrunk_one() {
        let dir = Scratch::new();
        assert_eq!(grown_since(&dir.0.join("gone"), 0), 0);
        std::fs::write(dir.0.join("a"), b"12").unwrap();
        assert_eq!(grown_since(&dir.0, 100), 0);
    }

    #[test]
    fn measuring_gets_a_tenth_of_the_time_within_bounds() {
        assert_eq!(measure_gap(Duration::ZERO), Duration::from_millis(20));
        assert_eq!(
            measure_gap(Duration::from_millis(15)),
            Duration::from_millis(150)
        );
        assert_eq!(
            measure_gap(Duration::from_secs(2)),
            Duration::from_millis(POLL_MS)
        );
    }

    #[test]
    fn limits_match_the_design() {
        assert_eq!(DISK_LIMIT_BYTES, 1_073_741_824);
        assert_eq!(POLL_MS, 500);
    }
}
