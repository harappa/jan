//! Tauri commands for the sandboxed python tool.
//!
//! The frontend calls these directly: only it knows the chat's attachments. The
//! bundled runtime and the data folder are the only places they read from; the
//! save destination is chosen by a native dialog opened here, never by a path
//! from the frontend.
//!
//! They live apart from `crate::commands` (an upstream file) so that file stays
//! free of this feature's code.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use super::availability::{self, PythonStatus};
use super::inputs::{self, Attachment};
use super::request::{self, RunSpec};
use super::run::{self, RunGuard, RunOutcome, StopReason};
use super::{runtime, save};
use crate::commands::without_error_prefix;
use crate::{workspace, AgentToolsError, ToolResult};

/// `message` without the `\\?\` verbatim prefix `canonicalize` adds on Windows,
/// so no path in a result carries it (the model and the user read these).
fn plain_paths(message: &str) -> String {
    message.replace(r"\\?\UNC\", r"\\").replace(r"\\?\", "")
}

/// A failed python call as a tool result, so the model can read the reason.
/// Same shape as every other tool's `ERROR: ...` result.
fn python_error(message: &str) -> ToolResult {
    ToolResult {
        content: format!("ERROR: {}", plain_paths(without_error_prefix(message))),
        diff: None,
        is_error: true,
        images: vec![],
    }
}

/// Where the installer put the Python runtime (`resources/python` beside the
/// app). In a build that did not fetch it, the folder holds only a stub.
fn bundled_python<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .map(|dir| dir.join("resources").join("python"))
        .map_err(|e| format!("cannot find the app's resource folder: {e}"))
}

/// The tool's availability: the runtime must be bundled in this build (a dev
/// build has only a stub) and the sandbox must work on this machine.
/// `sandbox` is `availability::status` (injected for tests); it is not asked
/// when there is no runtime, since the answer could not matter.
fn python_status_with(bundled: &Path, sandbox: impl FnOnce() -> PythonStatus) -> PythonStatus {
    if let Err(reason) = runtime::check_bundled(bundled) {
        return PythonStatus {
            available: false,
            reason: Some(plain_paths(&reason)),
        };
    }
    sandbox()
}

/// Whether the python tool can run here, so the frontend offers it only when it
/// can. Never fails: an unusable setup is an answer, not an error.
#[tauri::command]
pub async fn python_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> PythonStatus {
    let unavailable = |reason: String| PythonStatus {
        available: false,
        reason: Some(reason),
    };
    let bundled = match bundled_python(&app) {
        Ok(bundled) => bundled,
        Err(reason) => return unavailable(reason),
    };
    // The first sandbox probe talks to the OS and blocks.
    tokio::task::spawn_blocking(move || python_status_with(&bundled, availability::status))
        .await
        .unwrap_or_else(|e| unavailable(format!("the sandbox check failed: {e}")))
}

/// What runs the code once everything is staged: `run_python`, or a stand-in in
/// tests.
type RunFuture<'a> = Pin<Box<dyn Future<Output = Result<RunOutcome, String>> + Send + 'a>>;

/// What a run that was cancelled before it started reports: the same stop line
/// a cancelled run ends with.
fn cancelled_outcome() -> RunOutcome {
    RunOutcome {
        content: run::format_result(String::new(), None, Some(StopReason::Cancelled), &[], &[]),
        is_error: true,
    }
}

/// Remove a chat's staged inputs. Best effort: a leftover is retried by the next
/// run's staging (which empties the folder) and by the startup sweep.
async fn remove_inputs(dir: &Path) {
    match tokio::fs::remove_dir_all(dir).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!(
            "python run: cannot remove the inputs {}: {e}",
            dir.display()
        ),
    }
}

/// One python run: claim the chat, install the runtime if needed, stage the
/// attachments, run. Every failure comes back as an `ERROR: ...` result, never
/// as a rejected command, so the model can read why.
///
/// The chat is claimed before anything is staged (staging has no locking of its
/// own) and the claim is held until the run ends. A cancel can arrive at any
/// point of the setup (the Stop button, or the chat being deleted); it is
/// checked after each step that writes to disk, and a cancelled run removes
/// what it staged and never starts. Without that, a deleted chat's folders
/// would be created again by the steps still running.
///
/// `after_step` is told which step just ended (`"runtime"`, `"workspace"`,
/// `"inputs"`), before the check: a seam for tests.
#[allow(clippy::too_many_arguments)]
async fn python_run_with<F, S>(
    bundled: &Path,
    data_folder: &Path,
    thread_id: &str,
    code: &str,
    timeout_s: Option<u32>,
    attachments: Vec<Attachment>,
    after_step: S,
    run: F,
) -> ToolResult
where
    F: for<'a> FnOnce(RunSpec, &'a RunGuard, &'a str, &'a [(String, String)]) -> RunFuture<'a>
        + Send,
    S: Fn(&str) + Send,
{
    let attempt = async {
        // A bad id fails before anything is claimed or copied.
        workspace::thread_workspace(data_folder, thread_id)?;
        let inputs_dir = inputs::inputs_dir(data_folder, thread_id)?;
        let guard = run::begin_run(thread_id)?;

        // Copying the runtime and staging files are synchronous file work.
        let (bundled, data) = (bundled.to_path_buf(), data_folder.to_path_buf());
        let runtime_dir =
            tokio::task::spawn_blocking(move || runtime::ensure_runtime(&bundled, &data))
                .await
                .map_err(|e| format!("setting up the Python runtime failed: {e}"))??;
        after_step("runtime");
        if guard.is_cancelled() {
            return Ok(cancelled_outcome());
        }

        let workspace = workspace::ensure_thread_workspace(data_folder, thread_id).await?;
        after_step("workspace");
        if guard.is_cancelled() {
            return Ok(cancelled_outcome());
        }

        let staging_dir = inputs_dir.clone();
        let staged =
            tokio::task::spawn_blocking(move || inputs::stage_inputs(&staging_dir, &attachments))
                .await
                .map_err(|e| format!("staging the attachments failed: {e}"));
        after_step("inputs");
        // Whatever staging did to the folder, a cancelled run leaves none of it.
        if guard.is_cancelled() {
            remove_inputs(&inputs_dir).await;
            return Ok(cancelled_outcome());
        }
        let report = staged??;

        let spec = RunSpec {
            runtime: runtime_dir,
            workspace,
            inputs: inputs_dir,
            timeout_s: request::clamp_timeout(timeout_s),
        };
        run(spec, &guard, code, &report.skipped).await
    };
    match attempt.await {
        Ok(outcome) => ToolResult {
            content: outcome.content,
            diff: None,
            is_error: outcome.is_error,
            images: vec![],
        },
        Err(message) => python_error(&message),
    }
}

/// [`python_run_with`] running the real sandbox.
async fn python_run_inner(
    bundled: &Path,
    data_folder: &Path,
    thread_id: &str,
    code: &str,
    timeout_s: Option<u32>,
    attachments: Vec<Attachment>,
) -> ToolResult {
    python_run_with(
        bundled,
        data_folder,
        thread_id,
        code,
        timeout_s,
        attachments,
        |_| {},
        |spec, guard, code, skipped| Box::pin(run::run_python(spec, guard, code, skipped)),
    )
    .await
}

/// Run `code` in the chat's sandbox (see [`python_run_with`]). `attachments` are
/// the files the user attached; they are copied in as read-only inputs.
#[tauri::command]
pub async fn python_run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    data_folder: String,
    thread_id: String,
    code: String,
    timeout_s: Option<u32>,
    attachments: Vec<Attachment>,
) -> Result<ToolResult, AgentToolsError> {
    let bundled = match bundled_python(&app) {
        Ok(bundled) => bundled,
        Err(message) => return Ok(python_error(&message)),
    };
    Ok(python_run_inner(
        &bundled,
        Path::new(&data_folder),
        &thread_id,
        &code,
        timeout_s,
        attachments,
    )
    .await)
}

/// Stop the chat's python run (the Stop button). True when it had one. Async so
/// that killing the process never runs on the main thread.
#[tauri::command]
pub async fn python_cancel(thread_id: String) -> bool {
    run::cancel(&thread_id)
}

/// Copy a file from the chat's workspace to a place the user picks. `pick` gets
/// the file's name and returns the destination, or `None` when the user cancels.
///
/// The chat is claimed for the whole save: a run could otherwise rewrite the
/// workspace while the dialog is open, and a run cannot start meanwhile.
fn python_save_file_with(
    data_folder: &Path,
    thread_id: &str,
    relative_path: &str,
    pick: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Option<String>, String> {
    let workspace = workspace::thread_workspace(data_folder, thread_id)?;
    let _guard = run::begin_run(thread_id)?;
    let source = save::resolve_workspace_file(&workspace, relative_path)?;
    let saved = save::save_with(&source, pick)?;
    Ok(saved.map(|dest| {
        crate::tools::proc::without_verbatim_prefix(&dest)
            .to_string_lossy()
            .into_owned()
    }))
}

/// Save a file a python run left in the workspace. `Ok(None)` means the user
/// cancelled the dialog. The destination is chosen only by the native dialog
/// opened here.
#[tauri::command]
pub async fn python_save_file(
    data_folder: String,
    thread_id: String,
    relative_path: String,
) -> Result<Option<String>, AgentToolsError> {
    // The dialog blocks until it closes, so it must not sit on the async runtime
    // or the main thread.
    tokio::task::spawn_blocking(move || {
        python_save_file_with(
            Path::new(&data_folder),
            &thread_id,
            &relative_path,
            |name| rfd::FileDialog::new().set_file_name(name).save_file(),
        )
    })
    .await
    .map_err(|e| AgentToolsError::from(format!("saving the file failed: {e}")))?
    .map_err(|message| AgentToolsError::from(plain_paths(&message)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::python::inputs::inputs_dir;
    use crate::python::run::begin_run;
    use crate::python::runtime::{python_executable, runtime_dir, RUNTIME_ID};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A scratch data folder, removed on drop. Every test uses its own thread id,
    /// because the run registry is shared by the whole test process.
    struct Data(PathBuf);

    impl Data {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("jan_pycmd_{}_{}", std::process::id(), n));
            std::fs::create_dir_all(&dir).unwrap();
            Data(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// A bundled runtime that passes the checks (the interpreter is a stub).
        fn bundled(&self) -> PathBuf {
            let bundled = self.0.join("bundled-python");
            let exe = python_executable(&bundled);
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(&exe, "stub").unwrap();
            std::fs::write(bundled.join("jan-runtime-id"), RUNTIME_ID).unwrap();
            bundled
        }

        /// What a dev build has: a folder with no `jan-runtime-id`.
        fn stub_bundled(&self) -> PathBuf {
            let bundled = self.0.join("stub-python");
            std::fs::create_dir_all(&bundled).unwrap();
            std::fs::write(bundled.join(".keep"), "").unwrap();
            bundled
        }
    }

    impl Drop for Data {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ok_outcome(content: &str) -> Result<RunOutcome, String> {
        Ok(RunOutcome {
            content: content.to_string(),
            is_error: false,
        })
    }

    /// The pieces of a run that the fake runner saw.
    #[derive(Debug)]
    struct Seen {
        spec: RunSpec,
        code: String,
        skipped: Vec<(String, String)>,
        claim_refused_during_run: bool,
    }

    /// `python_run_with` driven by a runner that records what it was given and
    /// answers `answer`.
    async fn run_with_fake(
        bundled: &Path,
        data: &Path,
        thread: &str,
        timeout_s: Option<u32>,
        attachments: Vec<Attachment>,
        answer: Result<RunOutcome, String>,
    ) -> (ToolResult, Option<Seen>) {
        run_with_fake_hooked(
            bundled,
            data,
            thread,
            timeout_s,
            attachments,
            answer,
            |_| {},
        )
        .await
    }

    /// [`run_with_fake`] with `after_step` called as each setup step ends.
    async fn run_with_fake_hooked(
        bundled: &Path,
        data: &Path,
        thread: &str,
        timeout_s: Option<u32>,
        attachments: Vec<Attachment>,
        answer: Result<RunOutcome, String>,
        after_step: impl Fn(&str) + Send,
    ) -> (ToolResult, Option<Seen>) {
        let seen: Mutex<Option<Seen>> = Mutex::new(None);
        let thread_id = thread.to_string();
        let result = python_run_with(
            bundled,
            data,
            thread,
            "print(1)",
            timeout_s,
            attachments,
            after_step,
            |spec, _guard, code, skipped| {
                *seen.lock().unwrap() = Some(Seen {
                    spec,
                    code: code.to_string(),
                    skipped: skipped.to_vec(),
                    claim_refused_during_run: begin_run(&thread_id).is_err(),
                });
                Box::pin(async move { answer })
            },
        )
        .await;
        let seen = seen.into_inner().unwrap();
        (result, seen)
    }

    fn text_attachment(name: &str, content: &str) -> Attachment {
        Attachment {
            name: name.to_string(),
            path: None,
            content: Some(content.to_string()),
        }
    }

    // ---- python_status ----------------------------------------------------

    fn sandbox_ok() -> PythonStatus {
        PythonStatus {
            available: true,
            reason: None,
        }
    }

    #[test]
    fn status_is_unavailable_when_only_the_stub_runtime_is_bundled() {
        let data = Data::new();
        let status = python_status_with(&data.stub_bundled(), || {
            panic!("the sandbox is not probed when there is no runtime to run in")
        });
        assert!(!status.available);
        assert!(
            status
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("not bundled"),
            "reason: {:?}",
            status.reason
        );
    }

    #[test]
    fn status_follows_the_sandbox_when_the_runtime_is_bundled() {
        let data = Data::new();
        assert_eq!(
            python_status_with(&data.bundled(), sandbox_ok),
            sandbox_ok()
        );

        let no = PythonStatus {
            available: false,
            reason: Some("no sandbox here".to_string()),
        };
        assert_eq!(python_status_with(&data.bundled(), || no.clone()), no);
    }

    // ---- python_run -------------------------------------------------------

    #[tokio::test]
    async fn a_finished_run_is_returned_as_a_tool_result() {
        let data = Data::new();
        let (result, seen) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-ok",
            Some(999),
            vec![text_attachment("a.txt", "hello")],
            ok_outcome("1\n[exit 0]"),
        )
        .await;
        assert_eq!(result.content, "1\n[exit 0]");
        assert!(!result.is_error);
        assert!(result.diff.is_none());
        assert!(result.images.is_empty());

        let seen = seen.expect("the runner must be called");
        assert_eq!(seen.code, "print(1)");
        assert_eq!(seen.spec.timeout_s, 300, "the timeout is clamped");
        assert_eq!(seen.spec.runtime, runtime_dir(data.path()));
        assert_eq!(
            seen.spec.workspace,
            workspace::thread_workspace(data.path(), "py-ok").unwrap()
        );
        assert_eq!(seen.spec.inputs, inputs_dir(data.path(), "py-ok").unwrap());
        assert!(seen.spec.workspace.is_dir());
        assert_eq!(
            std::fs::read_to_string(seen.spec.inputs.join("a.txt")).unwrap(),
            "hello",
            "attachments are staged before the run"
        );
        assert!(runtime_dir(data.path()).join(".jan-complete").is_file());
    }

    #[tokio::test]
    async fn a_failed_run_keeps_its_error_flag() {
        let data = Data::new();
        let outcome = Ok(RunOutcome {
            content: "boom\n[exit 1]".to_string(),
            is_error: true,
        });
        let (result, _) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-fail",
            None,
            vec![],
            outcome,
        )
        .await;
        assert!(result.is_error);
        assert_eq!(result.content, "boom\n[exit 1]");
    }

    #[tokio::test]
    async fn the_skipped_attachments_reach_the_run_with_their_reasons() {
        let data = Data::new();
        let missing = data.path().join("missing.csv");
        let attachments = vec![
            text_attachment("..", "x"),
            Attachment {
                name: "gone.csv".to_string(),
                path: Some(missing.to_string_lossy().into_owned()),
                content: None,
            },
        ];
        let (_, seen) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-skip",
            None,
            attachments,
            ok_outcome("[exit 0]"),
        )
        .await;
        let skipped = seen.unwrap().skipped;
        assert_eq!(
            skipped,
            vec![
                ("..".to_string(), "invalid file name".to_string()),
                ("gone.csv".to_string(), "not a readable file".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn the_chat_is_claimed_for_the_whole_run_and_released_after() {
        let data = Data::new();
        let (_, seen) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-claim",
            None,
            vec![],
            ok_outcome("[exit 0]"),
        )
        .await;
        assert!(seen.unwrap().claim_refused_during_run);
        assert!(begin_run("py-claim").is_ok(), "the claim must be released");
    }

    #[tokio::test]
    async fn a_refused_claim_becomes_an_error_result_without_staging() {
        let data = Data::new();
        let _busy = begin_run("py-busy").unwrap();
        let attachments = vec![text_attachment("a.txt", "hello")];
        let (result, seen) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-busy",
            None,
            attachments,
            ok_outcome("[exit 0]"),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.starts_with("ERROR: "), "{}", result.content);
        assert!(
            result.content.contains("already in progress"),
            "{}",
            result.content
        );
        assert!(seen.is_none(), "nothing may run");
        assert!(
            !inputs_dir(data.path(), "py-busy").unwrap().exists(),
            "the running python's inputs must not be touched"
        );
    }

    #[tokio::test]
    async fn a_runtime_that_is_not_bundled_becomes_an_error_result() {
        let data = Data::new();
        let (result, seen) = run_with_fake(
            &data.stub_bundled(),
            data.path(),
            "py-nort",
            None,
            vec![],
            ok_outcome("[exit 0]"),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.starts_with("ERROR: "), "{}", result.content);
        assert!(result.content.contains("not bundled"), "{}", result.content);
        assert!(seen.is_none());
        assert!(begin_run("py-nort").is_ok(), "the claim must be released");
    }

    #[tokio::test]
    async fn a_staging_failure_becomes_an_error_result() {
        let data = Data::new();
        // A file where the inputs folder must go makes staging fail.
        let inputs_root = inputs_dir(data.path(), "py-stage")
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        std::fs::create_dir_all(inputs_root.parent().unwrap()).unwrap();
        std::fs::write(&inputs_root, "not a folder").unwrap();

        let (result, seen) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-stage",
            None,
            vec![text_attachment("a.txt", "hello")],
            ok_outcome("[exit 0]"),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.starts_with("ERROR: "), "{}", result.content);
        assert!(seen.is_none());
        assert!(begin_run("py-stage").is_ok(), "the claim must be released");
    }

    #[tokio::test]
    async fn a_run_that_cannot_start_becomes_an_error_result() {
        let data = Data::new();
        let (result, _) = run_with_fake(
            &data.bundled(),
            data.path(),
            "py-nostart",
            None,
            vec![],
            Err("python is not available on this machine: no sandbox".to_string()),
        )
        .await;
        assert!(result.is_error);
        assert_eq!(
            result.content,
            "ERROR: python is not available on this machine: no sandbox"
        );
        assert!(result.diff.is_none());
        assert!(result.images.is_empty());
        assert!(
            begin_run("py-nostart").is_ok(),
            "the claim must be released"
        );
    }

    #[tokio::test]
    async fn an_invalid_thread_id_becomes_an_error_result() {
        let data = Data::new();
        let result = python_run_inner(
            &data.bundled(),
            data.path(),
            "../evil",
            "print(1)",
            None,
            vec![],
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.starts_with("ERROR: "), "{}", result.content);
    }

    #[tokio::test]
    async fn the_real_runner_reports_a_missing_runtime_the_same_way() {
        let data = Data::new();
        let result = python_run_inner(
            &data.stub_bundled(),
            data.path(),
            "py-real",
            "print(1)",
            None,
            vec![],
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.starts_with("ERROR: "), "{}", result.content);
    }

    #[test]
    fn verbatim_prefixes_are_removed_from_messages() {
        assert_eq!(
            plain_paths(r"cannot read \\?\C:\Jan\x and \\?\UNC\srv\share\y"),
            r"cannot read C:\Jan\x and \\srv\share\y"
        );
        assert_eq!(plain_paths("nothing to change"), "nothing to change");
    }

    // ---- python_save_file -------------------------------------------------

    fn data_with_result_file(thread: &str) -> Data {
        let data = Data::new();
        let ws = workspace::thread_workspace(data.path(), thread).unwrap();
        std::fs::create_dir_all(ws.join("out")).unwrap();
        std::fs::write(ws.join("out").join("result.csv"), "a,b\n1,2\n").unwrap();
        data
    }

    #[test]
    fn saving_copies_the_workspace_file_to_the_chosen_place() {
        let data = data_with_result_file("py-save");
        let dest = data.path().join("chosen.csv");
        let want = dest.clone();
        let mut asked_for = None;
        let saved = python_save_file_with(data.path(), "py-save", "out/result.csv", |name| {
            asked_for = Some(name.to_string());
            Some(want)
        })
        .unwrap();
        assert_eq!(asked_for.as_deref(), Some("result.csv"));
        assert_eq!(saved.as_deref(), Some(dest.to_string_lossy().as_ref()));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "a,b\n1,2\n");
    }

    #[test]
    fn cancelling_the_dialog_saves_nothing_and_returns_none() {
        let data = data_with_result_file("py-cancel-dialog");
        let saved =
            python_save_file_with(data.path(), "py-cancel-dialog", "out/result.csv", |_| None)
                .unwrap();
        assert_eq!(saved, None);
    }

    #[cfg(windows)]
    #[test]
    fn the_destination_is_shown_without_the_verbatim_prefix() {
        let data = data_with_result_file("py-prefix");
        let dest = data.path().join("chosen.csv");
        let verbatim = PathBuf::from(format!(r"\\?\{}", dest.display()));
        let saved = python_save_file_with(data.path(), "py-prefix", "out/result.csv", |_| {
            Some(verbatim)
        })
        .unwrap()
        .unwrap();
        assert!(!saved.starts_with(r"\\?\"), "{saved}");
        assert_eq!(saved, dest.to_string_lossy());
    }

    #[test]
    fn a_path_outside_the_workspace_is_refused_before_the_dialog() {
        let data = data_with_result_file("py-escape");
        for bad in ["../x.txt", "/etc/passwd", "", "out/missing.csv", "out"] {
            let result = python_save_file_with(data.path(), "py-escape", bad, |_| {
                panic!("the dialog must not open for {bad:?}")
            });
            assert!(result.is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn an_invalid_thread_id_is_refused_before_the_dialog() {
        let data = data_with_result_file("py-id");
        let result = python_save_file_with(data.path(), "../py-id", "out/result.csv", |_| {
            panic!("the dialog must not open")
        });
        assert!(result.is_err());
    }

    #[test]
    fn saving_is_refused_while_a_run_is_active_in_the_chat() {
        let data = data_with_result_file("py-save-busy");
        let _run = begin_run("py-save-busy").unwrap();
        let err = python_save_file_with(data.path(), "py-save-busy", "out/result.csv", |_| {
            panic!("the dialog must not open while a run is active")
        })
        .unwrap_err();
        assert!(err.contains("already in progress"), "{err}");
    }

    #[test]
    fn no_run_can_start_in_the_chat_while_the_save_dialog_is_open() {
        let data = data_with_result_file("py-save-hold");
        let mut refused_during_dialog = false;
        python_save_file_with(data.path(), "py-save-hold", "out/result.csv", |_| {
            refused_during_dialog = begin_run("py-save-hold").is_err();
            None
        })
        .unwrap();
        assert!(refused_during_dialog);
        assert!(begin_run("py-save-hold").is_ok(), "released after the save");
    }

    #[test]
    fn the_claim_is_released_when_the_save_fails() {
        let data = data_with_result_file("py-save-fail");
        let _ = python_save_file_with(data.path(), "py-save-fail", "out/missing.csv", |_| None);
        assert!(begin_run("py-save-fail").is_ok());
    }

    // ---- deleting a chat ---------------------------------------------------

    #[tokio::test]
    async fn deleting_a_thread_cancels_its_python_run_first() {
        let data = Data::new();
        let df = data.path().to_string_lossy().into_owned();
        workspace::ensure_thread_workspace(data.path(), "py-del")
            .await
            .unwrap();
        let guard = begin_run("py-del").unwrap();
        assert!(!guard.is_cancelled());

        crate::commands::thread_workspace_delete(df, "py-del".to_string())
            .await
            .unwrap();
        assert!(
            guard.is_cancelled(),
            "the run must be cancelled by the delete"
        );
        assert!(!workspace::thread_workspace(data.path(), "py-del")
            .unwrap()
            .exists());
    }

    #[tokio::test]
    async fn deleting_a_thread_removes_its_python_inputs() {
        let data = Data::new();
        let df = data.path().to_string_lossy().into_owned();
        let inputs = inputs_dir(data.path(), "py-del-in").unwrap();
        std::fs::create_dir_all(&inputs).unwrap();
        std::fs::write(inputs.join("a.csv"), "x").unwrap();
        crate::commands::thread_workspace_delete(df, "py-del-in".to_string())
            .await
            .unwrap();
        assert!(!inputs.exists());
    }

    #[tokio::test]
    async fn the_cancel_command_reports_whether_a_run_was_stopped() {
        assert!(!python_cancel("py-cancel-none".to_string()).await);
        let guard = begin_run("py-cancel").unwrap();
        assert!(python_cancel("py-cancel".to_string()).await);
        assert!(guard.is_cancelled());
    }

    /// Cancel the chat's run from inside the setup, as the Stop button or a chat
    /// delete would from another task, and run again with `stage` as the moment.
    async fn cancelled_during(
        stage: &'static str,
        thread: &str,
    ) -> (Data, ToolResult, Option<Seen>) {
        let data = Data::new();
        let id = thread.to_string();
        let (result, seen) = run_with_fake_hooked(
            &data.bundled(),
            data.path(),
            thread,
            None,
            vec![text_attachment("a.txt", "hello")],
            ok_outcome("[exit 0]"),
            move |step| {
                if step == stage {
                    assert!(run::cancel(&id));
                }
            },
        )
        .await;
        (data, result, seen)
    }

    #[tokio::test]
    async fn a_cancel_during_any_setup_step_stops_the_run_before_it_starts() {
        for (stage, thread) in [
            ("runtime", "py-cx-runtime"),
            ("workspace", "py-cx-workspace"),
            ("inputs", "py-cx-inputs"),
        ] {
            let (data, result, seen) = cancelled_during(stage, thread).await;
            assert!(seen.is_none(), "{stage}: nothing may start");
            assert!(result.is_error, "{stage}");
            assert_eq!(
                result.content, "[stopped: cancelled by the user]",
                "{stage}"
            );
            assert!(
                !inputs_dir(data.path(), thread).unwrap().exists(),
                "{stage}: the staged inputs must not be left behind"
            );
            assert!(begin_run(thread).is_ok(), "{stage}: the claim is released");
        }
    }

    #[tokio::test]
    async fn a_cancel_before_the_workspace_exists_does_not_create_it() {
        let (data, _, _) = cancelled_during("runtime", "py-cx-no-ws").await;
        assert!(!workspace::thread_workspace(data.path(), "py-cx-no-ws")
            .unwrap()
            .exists());
    }

    #[tokio::test]
    async fn a_bad_thread_id_fails_before_the_runtime_is_installed() {
        let data = Data::new();
        let (result, seen) = run_with_fake(
            &data.bundled(),
            data.path(),
            "../evil",
            None,
            vec![],
            ok_outcome("[exit 0]"),
        )
        .await;
        assert!(result.is_error);
        assert!(result.content.starts_with("ERROR: "), "{}", result.content);
        assert!(
            !result.content.starts_with("ERROR: ERROR"),
            "{}",
            result.content
        );
        assert!(seen.is_none());
        assert!(
            !runtime_dir(data.path()).exists(),
            "the runtime must not be copied for a bad id"
        );
    }

    /// The stop step must run while the folders still exist, or a run could
    /// re-create them between the removal and the stop.
    #[tokio::test]
    async fn deleting_a_thread_stops_the_run_before_removing_anything() {
        let data = Data::new();
        let thread = "py-del-order";
        let workspace_dir = workspace::ensure_thread_workspace(data.path(), thread)
            .await
            .unwrap();
        let inputs = inputs_dir(data.path(), thread).unwrap();
        std::fs::create_dir_all(&inputs).unwrap();

        let mut seen = None;
        crate::commands::delete_thread_workspace(data.path(), thread, |id| {
            assert_eq!(id, thread);
            seen = Some((workspace_dir.is_dir(), inputs.is_dir()));
        })
        .await
        .unwrap();
        assert_eq!(seen, Some((true, true)), "both folders exist when stopping");
        assert!(!workspace_dir.exists());
        assert!(!inputs.exists());
    }
}
