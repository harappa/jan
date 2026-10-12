//! Running one python script in an MXC process container: output capture, the
//! time and disk limits, cancelling, and the result text the model reads.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use mxc_sdk::v1::{self, MxcProcess, SpawnOptions, StreamCloser, TelemetryConfig, WaitResult};

use super::availability::{self, PythonStatus};
use super::disk::{disk_stop, free_space, DiskStop, FolderWatch};
pub use super::disk::{DISK_LIMIT_BYTES, POLL_MS};
use super::request::{build_request, RunSpec, MAX_TIMEOUT_S};
use super::snapshot::{changed, snapshot, total_size, ChangedFile, MAX_LISTED_FILES};
use crate::tools::handlers::BashCapture;

/// How often the process is checked for exit, the deadline and the stops. The
/// disk is measured elsewhere (`FolderWatch`, and the free space every
/// `POLL_MS`), so this poll never waits on a walk.
const EXIT_POLL: Duration = Duration::from_millis(20);
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
    /// True when the exit code was not 0, the run timed out, or it was stopped
    /// (a disk limit, or cancelled).
    pub is_error: bool,
}

/// Why a run was stopped before it ended on its own (the timeout aside).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The workspace grew by more than `DISK_LIMIT_BYTES`.
    WorkspaceLimit,
    /// The volume's free space dropped by more than twice that.
    VolumeLimit,
    /// `cancel`, or the run's guard was dropped.
    Cancelled,
}

impl StopReason {
    /// The result line for this stop.
    pub fn marker(self) -> &'static str {
        match self {
            StopReason::WorkspaceLimit => {
                "[stopped: the run wrote more than 1 GB to the workspace]"
            }
            StopReason::VolumeLimit => "[stopped: the run used more than 2 GB of disk space]",
            StopReason::Cancelled => "[stopped: cancelled by the user]",
        }
    }
}

impl From<DiskStop> for StopReason {
    fn from(stop: DiskStop) -> Self {
        match stop {
            DiskStop::Folder => StopReason::WorkspaceLimit,
            DiskStop::Volume => StopReason::VolumeLimit,
        }
    }
}

/// Something a run can be stopped through (the sandboxed process; a fake in
/// tests).
trait Kill {
    fn kill_now(&self) -> std::io::Result<()>;
}

impl Kill for Mutex<MxcProcess> {
    fn kill_now(&self) -> std::io::Result<()> {
        lock(self).kill()
    }
}

/// Kill `process`, logging (not returning) a failure: the callers are a cancel
/// and a drop, which have no one to hand it to.
fn kill_logged<P: Kill>(process: &P, why: &str) {
    if let Err(e) = process.kill_now() {
        log::warn!("python run: could not kill the process ({why}): {e}");
    }
}

/// The run registered for one chat.
struct Slot<P> {
    /// Which claim (`begin`) this slot belongs to. A run whose token no longer
    /// matches was abandoned and must not touch a later run's slot.
    token: u64,
    /// Set while the sandboxed process exists, so `cancel` can kill it.
    process: Option<Arc<P>>,
    /// `cancel` was called for this run.
    cancelled: bool,
}

/// Which chats have a run, and how to stop each. One process-wide instance
/// (`registry()`); tests make their own with a fake process.
struct Registry<P> {
    runs: Mutex<HashMap<String, Slot<P>>>,
    next_token: AtomicU64,
}

impl<P: Kill> Registry<P> {
    fn new() -> Self {
        Registry {
            runs: Mutex::new(HashMap::new()),
            next_token: AtomicU64::new(1),
        }
    }

    /// Claim the chat; the token identifies this claim from now on.
    fn begin(&self, thread_id: &str) -> Result<u64, String> {
        let mut runs = lock(&self.runs);
        if runs.contains_key(thread_id) {
            return Err(ALREADY_RUNNING.to_string());
        }
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        runs.insert(
            thread_id.to_string(),
            Slot {
                token,
                process: None,
                cancelled: false,
            },
        );
        Ok(token)
    }

    /// Release the claim, killing its process if one is still attached (the
    /// caller gave up on the run).
    fn end(&self, thread_id: &str, token: u64) {
        let process = {
            let mut runs = lock(&self.runs);
            match runs.get(thread_id) {
                Some(slot) if slot.token == token => {
                    runs.remove(thread_id).and_then(|slot| slot.process)
                }
                _ => None,
            }
        };
        if let Some(process) = process {
            kill_logged(&*process, "the run was abandoned");
        }
    }

    /// Mark the chat's run cancelled and kill its process if it has one. True
    /// when the chat had a run.
    fn cancel(&self, thread_id: &str) -> bool {
        let process = {
            let mut runs = lock(&self.runs);
            let Some(slot) = runs.get_mut(thread_id) else {
                return false;
            };
            slot.cancelled = true;
            slot.process.clone()
        };
        if let Some(process) = process {
            kill_logged(&*process, "cancel");
        }
        true
    }

    /// Whether the claim `token` may no longer run: cancelled, or no longer the
    /// chat's current claim (released or replaced).
    fn is_cancelled(&self, thread_id: &str, token: u64) -> bool {
        lock(&self.runs)
            .get(thread_id)
            .map_or(true, |slot| slot.token != token || slot.cancelled)
    }

    /// Make the process reachable by `cancel`. True when the claim may no
    /// longer run; then nothing is recorded and the caller kills the process.
    fn attach(&self, thread_id: &str, token: u64, process: &Arc<P>) -> bool {
        let mut runs = lock(&self.runs);
        match runs.get_mut(thread_id) {
            Some(slot) if slot.token == token => {
                slot.process = Some(Arc::clone(process));
                slot.cancelled
            }
            _ => true,
        }
    }

    /// Forget the (finished) process. True when the run was cancelled or its
    /// claim was released meanwhile.
    fn detach(&self, thread_id: &str, token: u64) -> bool {
        let mut runs = lock(&self.runs);
        match runs.get_mut(thread_id) {
            Some(slot) if slot.token == token => {
                slot.process = None;
                slot.cancelled
            }
            _ => true,
        }
    }
}

fn registry() -> &'static Registry<Mutex<MxcProcess>> {
    static REGISTRY: OnceLock<Registry<Mutex<MxcProcess>>> = OnceLock::new();
    REGISTRY.get_or_init(Registry::new)
}

/// A poisoned lock only means another run panicked; the data is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One chat's claim on running python. Held from before the inputs are staged
/// until the run ends; dropping it releases the chat and kills a process that is
/// still running (the tool call was abandoned).
#[must_use = "the chat is free to run again as soon as the guard is dropped"]
pub struct RunGuard {
    thread_id: String,
    token: u64,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        registry().end(&self.thread_id, self.token);
    }
}

impl RunGuard {
    /// Whether `cancel` (or a newer claim) has ended this claim. The setup steps
    /// before the spawn check it so that a cancelled run never starts.
    pub fn is_cancelled(&self) -> bool {
        registry().is_cancelled(&self.thread_id, self.token)
    }
}

/// Claim the chat for one run. A second claim while one is held is refused at
/// once rather than queued.
pub fn begin_run(thread_id: &str) -> Result<RunGuard, String> {
    let token = registry().begin(thread_id)?;
    Ok(RunGuard {
        thread_id: thread_id.to_string(),
        token,
    })
}

/// Stop the chat's run: kill its process if it has started, or keep it from
/// starting. True when the chat had a run to stop.
pub fn cancel(thread_id: &str) -> bool {
    registry().cancel(thread_id)
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
    let claim = Claim {
        thread_id: guard.thread_id.clone(),
        token: guard.token,
    };
    let code = code.to_string();
    let skipped = skipped.to_vec();
    // Everything below blocks: the first availability check probes MXC, and the
    // snapshots, the spawn, the pipes and the waits are all synchronous. It may
    // outlive this future (and the guard): the token makes it stop then.
    tokio::task::spawn_blocking(move || {
        let status = status();
        if !status.available {
            return Err(format!(
                "python is not available on this machine: {}",
                status.reason.as_deref().unwrap_or("unknown reason")
            ));
        }
        run_blocking(&spec, &claim, &code, &skipped)
    })
    .await
    .map_err(|e| format!("the python run failed: {e}"))?
}

/// The run's chat and claim, as the blocking part sees them.
struct Claim {
    thread_id: String,
    token: u64,
}

/// How the watch over a running process ended.
#[derive(Default)]
struct Watch {
    timed_out: bool,
    stopped: Option<StopReason>,
    /// The process could not be checked or stopped.
    error: Option<String>,
}

fn run_blocking(
    spec: &RunSpec,
    claim: &Claim,
    code: &str,
    skipped: &[(String, String)],
) -> Result<RunOutcome, String> {
    let runs = registry();
    let thread_id = claim.thread_id.as_str();
    if runs.is_cancelled(thread_id, claim.token) {
        return Err(CANCELLED.to_string());
    }
    let before =
        snapshot(&spec.workspace).map_err(|e| format!("cannot read the python workspace: {e}"))?;
    let before_size = total_size(&before);
    let start_free = free_space(&spec.workspace);
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
    lower_priority(process.id());
    // The timeout is the script's own time, so it counts from the spawn.
    let deadline = Instant::now() + Duration::from_secs(u64::from(spec.timeout_s));

    let stdin = process.take_stdin();
    let closers: Vec<StreamCloser> = [process.stdout_closer(), process.stderr_closer()]
        .into_iter()
        .flatten()
        .collect();
    let streams = [process.take_stdout(), process.take_stderr()];
    let process = Arc::new(Mutex::new(process));
    if runs.attach(thread_id, claim.token, &process) {
        // Cancelled, or abandoned by its caller, before the spawn finished.
        kill_logged(&*process, "the run was cancelled while starting");
    }

    // Never spills to a file: the overflow is cut, and the cut is reported.
    let capture = Arc::new(Mutex::new(BashCapture::without_spill()));
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

    let folder = FolderWatch::start(spec.workspace.clone(), before_size);
    // The folder's growth is checked on every poll (the walk thread refreshes
    // it); the free space is read every `POLL_MS` and reused in between.
    let mut now_free = start_free;
    let mut free_read = Instant::now();
    let watch = watch(&process, deadline, &mut || {
        if free_read.elapsed() >= Duration::from_millis(POLL_MS) {
            now_free = free_space(&spec.workspace);
            free_read = Instant::now();
        }
        disk_stop(start_free, now_free, folder.growth())
    });
    drop(folder);
    let waited = if watch.error.is_some() {
        // Not known to be gone: `wait` could block for the whole timeout, and
        // dropping the handle kills the tree anyway.
        None
    } else {
        Some(lock(&process).wait())
    };
    let cancelled = runs.detach(thread_id, claim.token);
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
    let stopped = watch
        .stopped
        .or_else(|| cancelled.then_some(StopReason::Cancelled));

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
        stopped,
        skipped,
        &files,
    );
    log::info!(
        "python run: thread {thread_id}, {:.2} s, exit {}, timed out {timed_out}, \
         stopped {stopped:?}, {} output bytes",
        started.elapsed().as_secs_f64(),
        code.map_or_else(|| "none".to_string(), |c| c.to_string()),
        output_bytes.load(Ordering::Relaxed),
    );
    Ok(RunOutcome {
        content,
        is_error: code != Some(0) || timed_out || stopped.is_some(),
    })
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

/// Wait for the process to end, enforcing the deadline and stopping it when
/// `disk` says so. `disk` is asked on every poll and must be cheap (it reads
/// the latest walk's result and a cached free space, never walks itself).
///
/// MXC enforces `timeout_ms` only inside `wait` on Windows (its `try_wait`
/// reports a timeout only after `kill_for_timeout`), while Bubblewrap's
/// `try_wait` enforces it itself. So the deadline is kept here too, and a
/// `TimedOut` from `try_wait` is taken as the timeout either way.
fn watch(
    process: &Mutex<MxcProcess>,
    deadline: Instant,
    disk: &mut dyn FnMut() -> Option<DiskStop>,
) -> Watch {
    let mut watch = Watch::default();
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
        } else if let Some(stop) = disk() {
            if let Err(e) = lock(process).kill() {
                watch.error = Some(format!("cannot stop the python process: {e}"));
                return watch;
            }
            watch.stopped = Some(stop.into());
            killed_at = Some(now);
            continue;
        }
        std::thread::sleep(EXIT_POLL);
    }
}

/// Give the sandboxed process below-normal CPU priority, so a busy script does
/// not slow the app down. Processes it starts inherit the class. A failure is
/// logged and the run goes on.
#[cfg(windows)]
fn lower_priority(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };
    // SAFETY: plain Win32 calls on a handle opened and closed here. The pid
    // cannot be reused meanwhile: MXC holds a handle to the process until it is
    // reaped.
    let result = unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle.is_null() {
            Err(std::io::Error::last_os_error())
        } else {
            let ok = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            if ok == 0 {
                Err(error)
            } else {
                Ok(())
            }
        }
    };
    if let Err(e) = result {
        log::warn!("python run: could not lower the priority ({e}); continuing");
    }
}

/// Unix lowers the priority in the command itself (`nice -n 10`, see
/// `request::build_request`): the pid MXC returns there is Bubblewrap's
/// wrapper, which has already started python.
#[cfg(not(windows))]
fn lower_priority(_pid: u32) {}

/// A run that ended in a tool error. `error` is our own message, never the
/// script's output.
fn log_failure(thread_id: &str, started: Instant, error: String) -> String {
    log::warn!(
        "python run: thread {thread_id}, {:.2} s, failed: {error}",
        started.elapsed().as_secs_f64()
    );
    error
}

/// The text the model reads: the captured output (ending in `[exit N]`), then
/// one line per skipped input, the timeout, the stop, and each changed file
/// (at most `MAX_LISTED_FILES`, the rest counted).
pub fn format_result(
    captured: String,
    timed_out: Option<u32>,
    stopped: Option<StopReason>,
    skipped: &[(String, String)],
    files: &[ChangedFile],
) -> String {
    let mut out = captured;
    let mut line = |text: &str| {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(text);
    };
    for (name, reason) in skipped {
        line(&format!("[input skipped: {name} ({reason})]"));
    }
    if let Some(seconds) = timed_out {
        line(&format!(
            "[timed out after {seconds} s: split the work or pass a larger timeout, up to {MAX_TIMEOUT_S}]"
        ));
    }
    if let Some(stop) = stopped {
        line(stop.marker());
    }
    for file in files.iter().take(MAX_LISTED_FILES) {
        line(&format!("[file: {} ({} bytes)]", file.path, file.size));
    }
    if files.len() > MAX_LISTED_FILES {
        line(&format!(
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
            Some(StopReason::WorkspaceLimit),
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
            format_result("[exit 0]".to_string(), None, None, &[], &[]),
            "[exit 0]"
        );
    }

    #[test]
    fn every_skipped_input_gets_its_own_line_with_the_reason_verbatim() {
        let out = format_result(
            "[exit 0]".to_string(),
            None,
            None,
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
        let out = format_result("[exit 0]".to_string(), None, None, &[], &files);
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
        let out = format_result("[exit 0]".to_string(), None, None, &[], &files);
        assert_eq!(out.lines().count(), 51);
        assert!(!out.contains("more not listed"));
    }

    #[test]
    fn japanese_paths_are_kept_as_they_are() {
        let out = format_result(
            "[exit 0]".to_string(),
            None,
            None,
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
            Some(StopReason::WorkspaceLimit),
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

    #[test]
    fn every_stop_has_its_exact_marker() {
        assert_eq!(
            StopReason::WorkspaceLimit.marker(),
            "[stopped: the run wrote more than 1 GB to the workspace]"
        );
        assert_eq!(
            StopReason::VolumeLimit.marker(),
            "[stopped: the run used more than 2 GB of disk space]"
        );
        assert_eq!(
            StopReason::Cancelled.marker(),
            "[stopped: cancelled by the user]"
        );
        assert_eq!(
            StopReason::from(DiskStop::Folder),
            StopReason::WorkspaceLimit
        );
        assert_eq!(StopReason::from(DiskStop::Volume), StopReason::VolumeLimit);
    }

    #[test]
    fn a_cancelled_run_says_so_after_the_exit_and_before_the_files() {
        let out = format_result(
            "partial\n[exit -1]".to_string(),
            None,
            Some(StopReason::Cancelled),
            &[skipped("a.bin", "larger than 256 MB")],
            &[file("half.csv", 3)],
        );
        assert_eq!(
            out,
            "partial\n[exit -1]\n\
             [input skipped: a.bin (larger than 256 MB)]\n\
             [stopped: cancelled by the user]\n\
             [file: half.csv (3 bytes)]"
        );
    }

    #[test]
    fn the_volume_stop_follows_a_timeout() {
        let out = format_result(
            "[terminated by signal]".to_string(),
            Some(2),
            Some(StopReason::VolumeLimit),
            &[],
            &[],
        );
        assert_eq!(
            out,
            "[terminated by signal]\n\
             [timed out after 2 s: split the work or pass a larger timeout, up to 300]\n\
             [stopped: the run used more than 2 GB of disk space]"
        );
    }

    /// A stand-in for the sandboxed process that counts kills.
    #[derive(Default)]
    struct Fake {
        kills: std::sync::atomic::AtomicUsize,
        fail: bool,
    }

    impl Kill for Fake {
        fn kill_now(&self) -> std::io::Result<()> {
            self.kills.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                Err(std::io::Error::other("cannot kill"))
            } else {
                Ok(())
            }
        }
    }

    fn kills(fake: &Arc<Fake>) -> usize {
        fake.kills.load(Ordering::SeqCst)
    }

    #[test]
    fn a_claim_released_before_its_spawn_leaves_no_slot_behind() {
        let runs = Registry::<Fake>::new();
        let token = runs.begin("t").unwrap();
        // The caller gave up while the blocking part was still starting.
        runs.end("t", token);
        assert!(runs.is_cancelled("t", token));
        let late = Arc::new(Fake::default());
        assert!(
            runs.attach("t", token, &late),
            "the late process is refused"
        );
        assert!(
            lock(&runs.runs).is_empty(),
            "attach must not re-create the slot"
        );
        assert!(runs.detach("t", token));
        assert!(lock(&runs.runs).is_empty());
        let next = runs.begin("t").expect("the chat is free again");
        runs.end("t", next);
    }

    #[test]
    fn a_stale_run_cannot_touch_the_next_runs_slot() {
        let runs = Registry::<Fake>::new();
        let old = runs.begin("t").unwrap();
        runs.end("t", old);
        let new = runs.begin("t").unwrap();
        assert_ne!(old, new);

        let current = Arc::new(Fake::default());
        assert!(!runs.attach("t", new, &current));
        let stale = Arc::new(Fake::default());
        assert!(runs.attach("t", old, &stale));
        assert!(runs.detach("t", old), "a stale run counts as cancelled");
        assert!(!runs.is_cancelled("t", new));
        runs.end("t", old);
        assert!(runs.begin("t").is_err(), "a stale end leaves the new claim");

        // The new run's process is still the one `cancel` reaches.
        assert!(runs.cancel("t"));
        assert_eq!(kills(&current), 1);
        assert_eq!(kills(&stale), 0);
        assert!(runs.detach("t", new));
        runs.end("t", new);
        assert!(lock(&runs.runs).is_empty());
    }

    #[test]
    fn ending_a_claim_kills_its_running_process() {
        let runs = Registry::<Fake>::new();
        let token = runs.begin("t").unwrap();
        let process = Arc::new(Fake::default());
        assert!(!runs.attach("t", token, &process));
        runs.end("t", token);
        assert_eq!(kills(&process), 1);
        assert!(lock(&runs.runs).is_empty());
    }

    #[test]
    fn a_finished_process_is_not_killed_when_the_claim_ends() {
        let runs = Registry::<Fake>::new();
        let token = runs.begin("t").unwrap();
        let process = Arc::new(Fake::default());
        assert!(!runs.attach("t", token, &process));
        assert!(!runs.detach("t", token), "not cancelled");
        runs.end("t", token);
        assert_eq!(kills(&process), 0);
    }

    #[test]
    fn cancel_before_the_spawn_makes_the_attach_refuse() {
        let runs = Registry::<Fake>::new();
        let token = runs.begin("t").unwrap();
        assert!(runs.cancel("t"));
        assert!(runs.is_cancelled("t", token));
        let process = Arc::new(Fake::default());
        assert!(runs.attach("t", token, &process));
        assert!(runs.detach("t", token));
        runs.end("t", token);
    }

    #[test]
    fn cancel_kills_a_running_process_and_the_detach_reports_it() {
        let runs = Registry::<Fake>::new();
        let token = runs.begin("t").unwrap();
        let process = Arc::new(Fake::default());
        assert!(!runs.attach("t", token, &process));
        assert!(runs.cancel("t"));
        assert_eq!(kills(&process), 1);
        assert!(runs.detach("t", token));
        runs.end("t", token);
        assert_eq!(kills(&process), 1, "detached, so not killed again");
    }

    #[test]
    fn a_failed_kill_on_cancel_is_logged_not_fatal() {
        let runs = Registry::<Fake>::new();
        let token = runs.begin("t").unwrap();
        let process = Arc::new(Fake {
            fail: true,
            ..Fake::default()
        });
        assert!(!runs.attach("t", token, &process));
        assert!(runs.cancel("t"));
        assert_eq!(kills(&process), 1);
        runs.end("t", token);
    }

    fn entered() -> &'static std::sync::Barrier {
        static B: OnceLock<std::sync::Barrier> = OnceLock::new();
        B.get_or_init(|| std::sync::Barrier::new(2))
    }

    fn released() -> &'static std::sync::Barrier {
        static B: OnceLock<std::sync::Barrier> = OnceLock::new();
        B.get_or_init(|| std::sync::Barrier::new(2))
    }

    /// An availability check that holds the run until the test lets it go.
    fn held_status() -> PythonStatus {
        entered().wait();
        released().wait();
        available()
    }

    #[test]
    fn dropping_the_guard_while_the_check_runs_frees_the_chat() {
        let id = unique_thread();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let guard = begin_run(&id).unwrap();
            let run = run_python_checked(missing_spec(), &guard, "print(1)", &[], held_status);
            let in_check = tokio::task::spawn_blocking(|| entered().wait());
            tokio::select! {
                _ = run => panic!("the run cannot finish while its check is held"),
                _ = in_check => {}
            }
            // The run's future is gone; now its guard goes too, while the
            // blocking part is still inside the availability check.
            drop(guard);
        });
        assert!(
            !lock(&registry().runs).contains_key(&id),
            "no slot is left behind"
        );
        let next = begin_run(&id).expect("the chat is free at once");
        // Let the abandoned run go on: it must stop by itself and leave the
        // new claim alone.
        released().wait();
        let next_token = next.token;
        // It needs milliseconds; a second of checks covers it.
        for _ in 0..10 {
            {
                let runs = lock(&registry().runs);
                let slot = runs.get(&id).expect("the new claim stays");
                assert_eq!(slot.token, next_token);
                assert!(slot.process.is_none() && !slot.cancelled);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        drop(next);
        assert!(!lock(&registry().runs).contains_key(&id));
        drop(rt);
    }

    #[test]
    fn limits_match_the_design() {
        assert_eq!(DISK_LIMIT_BYTES, 1_073_741_824);
        assert_eq!(POLL_MS, 500);
    }
}
