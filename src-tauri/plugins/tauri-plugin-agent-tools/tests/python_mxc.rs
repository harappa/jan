//! Runs python for real inside the MXC process container.
//!
//! Only when `JAN_TEST_MXC=1`; otherwise every test returns at once. The
//! runtime comes from `JAN_TEST_PYTHON_RUNTIME`, a folder that contains
//! `python/` (as `scripts/download-python-runtime.mjs` lays it out).
//!
//! The tests run one at a time: each starts a container, and the timing and
//! disk-limit cases should not compete with the others for the machine.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri_plugin_agent_tools::python::request::RunSpec;
use tauri_plugin_agent_tools::python::run::{begin_run, cancel, run_python, RunOutcome};
use tauri_plugin_agent_tools::python::runtime::python_executable;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const TIMEOUT_MARKER: &str =
    "[timed out after 2 s: split the work or pass a larger timeout, up to 300]";
const DISK_MARKER: &str = "[stopped: the run wrote more than 1 GB to the workspace]";
#[cfg(windows)]
const VOLUME_MARKER: &str = "[stopped: the run used more than 2 GB of disk space]";
const GIB: u64 = 1 << 30;

/// The runtime folder, or `None` (test skipped) unless `JAN_TEST_MXC=1`.
fn runtime() -> Option<PathBuf> {
    if std::env::var("JAN_TEST_MXC").as_deref() != Ok("1") {
        eprintln!("skipping: set JAN_TEST_MXC=1 to run python in MXC");
        return None;
    }
    let runtime = PathBuf::from(
        std::env::var_os("JAN_TEST_PYTHON_RUNTIME")
            .expect("JAN_TEST_PYTHON_RUNTIME must name a folder that contains python/"),
    );
    assert!(
        python_executable(&runtime).is_file(),
        "no interpreter at {}",
        python_executable(&runtime).display()
    );
    Some(runtime)
}

/// A workspace and an inputs folder under the temp dir, removed on drop.
struct Fixture {
    base: PathBuf,
    spec: RunSpec,
    thread: String,
}

impl Fixture {
    fn new(runtime: &Path, timeout_s: u32) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("jan_python_mxc_{}_{n}", std::process::id()));
        let workspace = base.join("workspace");
        let inputs = base.join("inputs");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&inputs).unwrap();
        Fixture {
            spec: RunSpec {
                runtime: runtime.to_path_buf(),
                workspace,
                inputs,
                timeout_s,
            },
            thread: format!("mxc-test-{}-{n}", std::process::id()),
            base,
        }
    }

    async fn run(&self, code: &str) -> RunOutcome {
        let guard = begin_run(&self.thread).expect("chat is free");
        run_python(self.spec.clone(), &guard, code, &[])
            .await
            .expect("run")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// `path` as a python string literal.
fn py_str(path: &Path) -> String {
    format!("{:?}", path.to_str().expect("utf-8 path"))
}

#[tokio::test(flavor = "multi_thread")]
async fn computes_exactly() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    let out = f
        .run("import math, sys\nsys.set_int_max_str_digits(0)\nprint(len(str(math.factorial(10000))))")
        .await;
    assert_eq!(out.content, "35660\n[exit 0]");
    assert!(!out.is_error);
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_to_the_workspace_and_lists_the_files() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    let out = f
        .run(
            "import os\n\
             open('out.txt', 'wb').write(b'hi')\n\
             os.makedirs('結果', exist_ok=True)\n\
             open('結果/表.csv', 'wb').write(b'a,b\\n')",
        )
        .await;
    assert_eq!(
        out.content,
        "[exit 0]\n[file: out.txt (2 bytes)]\n[file: 結果/表.csv (4 bytes)]"
    );
    assert_eq!(
        std::fs::read(f.spec.workspace.join("out.txt")).unwrap(),
        b"hi"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn inputs_are_readable_but_not_writable() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    std::fs::write(f.spec.inputs.join("a.txt"), "hello").unwrap();
    let out = f
        .run(
            "import os\n\
             d = os.environ['JAN_INPUTS']\n\
             print(open(os.path.join(d, 'a.txt')).read())\n\
             for name, mode in (('b.txt', 'w'), ('a.txt', 'a')):\n\
             \x20   try:\n\
             \x20       open(os.path.join(d, name), mode).write('x')\n\
             \x20       print('written', name)\n\
             \x20   except OSError:\n\
             \x20       print('denied')",
        )
        .await;
    assert_eq!(out.content, "hello\ndenied\ndenied\n[exit 0]");
    assert!(!f.spec.inputs.join("b.txt").exists());
    assert_eq!(
        std::fs::read_to_string(f.spec.inputs.join("a.txt")).unwrap(),
        "hello"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_home_folder_cannot_be_read() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .expect("home folder");
    // A file only the real home holds; removed on drop, also when the test fails.
    let probe = HomeProbe::new(&home);
    let probe_name = probe.name();
    let out = f
        .run(&format!(
            "import json, os\n\
             try:\n\
             \x20   open({probe}).read()\n\
             \x20   print('probe read')\n\
             except OSError:\n\
             \x20   print('probe denied')\n\
             try:\n\
             \x20   print('entries', json.dumps(sorted(os.listdir({home}))))\n\
             except OSError:\n\
             \x20   print('listing denied')",
            probe = py_str(&probe.0),
            home = py_str(&home),
        ))
        .await;
    let lines: Vec<&str> = out.content.lines().collect();
    assert_eq!(lines.len(), 3, "{}", out.content);
    assert_eq!(lines[0], "probe denied", "{}", out.content);
    assert_eq!(lines[2], "[exit 0]");
    if cfg!(windows) {
        // BaseContainer refuses the listing outright.
        assert_eq!(lines[1], "listing denied", "{}", out.content);
    } else if lines[1] != "listing denied" {
        // Bubblewrap shows no real home content, only the empty folders it
        // creates as mount points for granted paths below the home (the
        // runtime and data folders often live there).
        let names: Vec<String> =
            serde_json::from_str(lines[1].strip_prefix("entries ").expect("a listing"))
                .expect("json list");
        let allowed = granted_names_below(&home, &f.spec);
        assert!(!names.contains(&probe_name), "{names:?}");
        for name in &names {
            assert!(
                allowed.contains(name),
                "home shows {name:?}; only {allowed:?} may appear"
            );
        }
    }
}

/// Runs without MXC: the helper that decides which home entries may show.
#[test]
fn granted_names_below_takes_the_first_component_inside_home() {
    let home = PathBuf::from("base").join("home");
    let spec = RunSpec {
        runtime: home.join("jan-mxc-spike").join("rt"),
        workspace: home.join(".local").join("share").join("Jan").join("ws"),
        inputs: PathBuf::from("elsewhere").join("inputs"),
        timeout_s: 30,
    };
    assert_eq!(
        granted_names_below(&home, &spec),
        vec![".local".to_string(), "jan-mxc-spike".to_string()]
    );
}

/// A uniquely named file directly in the home folder, removed on drop.
struct HomeProbe(PathBuf);

impl HomeProbe {
    fn new(home: &Path) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = home.join(format!(
            ".jan_mxc_home_probe_{}_{nanos}",
            std::process::id()
        ));
        std::fs::write(&path, "home secret").expect("write the home probe");
        HomeProbe(path)
    }

    fn name(&self) -> String {
        self.0.file_name().unwrap().to_string_lossy().into_owned()
    }
}

impl Drop for HomeProbe {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The first path component below `home` of each folder the run is granted
/// (workspace, runtime, inputs) that lies inside the home.
fn granted_names_below(home: &Path, spec: &RunSpec) -> Vec<String> {
    [&spec.workspace, &spec.runtime, &spec.inputs]
        .into_iter()
        .filter_map(|p| p.strip_prefix(home).ok())
        .filter_map(|rel| rel.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn there_is_no_network() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    // A listener on the host's loopback: reaching it would prove the network
    // is open. The second address is TEST-NET-1 (RFC 5737), which is never
    // routed, so no traffic can leave the machine whatever happens.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let out = f
        .run(&format!(
            "import socket\n\
             def probe(addr):\n\
             \x20   try:\n\
             \x20       socket.create_connection(addr, timeout=2).close()\n\
             \x20       return 'connected'\n\
             \x20   except TimeoutError:\n\
             \x20       return 'timeout'\n\
             \x20   except OSError:\n\
             \x20       return 'blocked'\n\
             print(probe(('127.0.0.1', {port})))\n\
             print(probe(('192.0.2.1', 443)))"
        ))
        .await;
    let lines: Vec<&str> = out.content.lines().collect();
    assert_eq!(lines.len(), 3, "{}", out.content);
    assert_ne!(lines[0], "connected", "{}", out.content);
    assert_ne!(lines[1], "connected", "{}", out.content);
    assert_eq!(lines[2], "[exit 0]");
    assert!(
        listener.accept().is_err(),
        "the sandbox reached the host loopback"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_apps_environment_is_not_passed() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    // SAFETY: edition 2021, where `set_var` is a safe fn; no test reads it.
    std::env::set_var("JAN_TEST_SECRET", "do-not-pass");
    let out = f
        .run("import os\nprint('JAN_TEST_SECRET' in os.environ, os.environ.get('PYTHONUTF8'))")
        .await;
    assert_eq!(out.content, "False 1\n[exit 0]");
}

#[tokio::test(flavor = "multi_thread")]
async fn text_and_odd_output() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);

    let out = f.run("print('日本語')").await;
    assert_eq!(out.content, "日本語\n[exit 0]");

    let out = f.run("pass").await;
    assert_eq!(out.content, "[exit 0]");
    assert!(!out.is_error);

    let out = f.run("import sys\nsys.stdout.buffer.write(b'\\xff')").await;
    assert_eq!(out.content, "\u{FFFD}\n[exit 0]");

    let out = f.run("raise SystemExit(3)").await;
    assert_eq!(out.content, "[exit 3]");
    assert!(out.is_error);
}

#[tokio::test(flavor = "multi_thread")]
async fn long_output_keeps_the_end() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);

    // One line with no newline: only the last 64 KiB is kept, and the cut is
    // reported. Nothing is written to a file.
    let out = f
        .run("import sys\nsys.stdout.write('a' * 100000 + 'END')")
        .await;
    let (body, note) = out.content.rsplit_once('\n').unwrap();
    assert_eq!(body.len(), 64 * 1024 + "\n[exit 0]".len());
    assert!(body.ends_with("aaaEND\n[exit 0]"));
    assert_eq!(
        note,
        format!("[output truncated at {} of 100003 bytes]", body.len())
    );
    assert!(!out.is_error);

    // Too many lines: the last 2000 are kept and the same plain note follows.
    let out = f.run("for i in range(3000):\n    print('line', i)").await;
    let (body, note) = out.content.rsplit_once('\n').unwrap();
    eprintln!("truncation line: {note}");
    assert!(body.starts_with("line 1000\n"));
    assert!(body.ends_with("line 2999\n[exit 0]"));
    // The total counts raw bytes: Windows text-mode stdout ends lines in CRLF.
    let eol = if cfg!(windows) { 2 } else { 1 };
    let total: usize = (0..3000).map(|i| format!("line {i}").len() + eol).sum();
    assert_eq!(
        note,
        format!("[output truncated at {} of {total} bytes]", body.len())
    );
    assert!(!out.is_error);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_past_its_time_is_stopped() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 2);
    let started = Instant::now();
    let out = f
        .run("import time\nprint('start', flush=True)\ntime.sleep(10)")
        .await;
    let took = started.elapsed();
    assert!(out.content.starts_with("start\n"), "{}", out.content);
    assert!(out.content.ends_with(TIMEOUT_MARKER), "{}", out.content);
    assert!(out.is_error);
    assert!(took < Duration::from_secs(8), "took {took:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_writing_too_much_is_stopped() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 120);
    let out = f
        .run(
            "chunk = b'\\0' * (4 << 20)\n\
             with open('big.bin', 'wb') as out:\n\
             \x20   for _ in range(512):\n\
             \x20       out.write(chunk)\n\
             print('wrote 2 GiB')",
        )
        .await;
    let size = std::fs::metadata(f.spec.workspace.join("big.bin"))
        .map(|m| m.len())
        .unwrap_or(0);
    eprintln!("stopped at {size} bytes");
    assert!(out.content.contains(DISK_MARKER), "{}", out.content);
    assert!(!out.content.contains("wrote 2 GiB"));
    assert!(out.is_error);
    assert!(size >= GIB, "stopped early at {size}");
    assert!(size <= GIB + GIB / 2, "went on to {size}");
}

/// An alternate data stream holds bytes the folder walk does not count (the
/// file's size is its main stream). The free-space backstop stops it.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn writes_the_walk_cannot_see_hit_the_volume_backstop() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 120);
    let out = f
        .run(
            "chunk = b'\\1' * (4 << 20)\n\
             with open('cover.txt:hidden', 'wb') as out:\n\
             \x20   for _ in range(1536):\n\
             \x20       out.write(chunk)\n\
             print('wrote 6 GiB')",
        )
        .await;
    let size = std::fs::metadata(f.spec.workspace.join("cover.txt:hidden"))
        .map(|m| m.len())
        .unwrap_or(0);
    eprintln!("hidden stream stopped at {size} bytes");
    assert!(out.content.contains(VOLUME_MARKER), "{}", out.content);
    assert!(!out.content.contains(DISK_MARKER), "{}", out.content);
    assert!(!out.content.contains("wrote 6 GiB"));
    assert!(out.is_error);
    assert!(size > 2 * GIB, "stopped early at {size}");
    assert!(size < 4 * GIB, "went on to {size}");
}

/// The caller gives up on a run (its future is dropped): the process is
/// killed with the guard, and the chat can run again at once.
#[tokio::test(flavor = "multi_thread")]
async fn an_abandoned_run_is_killed_and_frees_the_chat() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 60);
    let spec = f.spec.clone();
    let thread = f.thread.clone();
    let running = tokio::spawn(async move {
        let guard = begin_run(&thread).expect("chat is free");
        run_python(
            spec,
            &guard,
            "import time\nopen('alive', 'w').close()\ntime.sleep(30)",
            &[],
        )
        .await
    });
    let alive = f.spec.workspace.join("alive");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !alive.exists() {
        assert!(Instant::now() < deadline, "the run never started");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    let out = f.run("print('next')").await;
    assert_eq!(out.content, "next\n[exit 0]");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_stops_the_run_and_the_next_one_works() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 60);
    let spec = f.spec.clone();
    let thread = f.thread.clone();
    let started = Instant::now();
    let running = tokio::spawn(async move {
        let guard = begin_run(&thread).expect("chat is free");
        run_python(spec, &guard, "import time\ntime.sleep(30)", &[]).await
    });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(cancel(&f.thread));
    let result = tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .expect("the cancelled run returns promptly")
        .unwrap();
    // Started for 1.5 s, so the process exists and is killed.
    let out = result.expect("a started run returns its output");
    assert!(
        out.content
            .ends_with("[exit -1]\n[stopped: cancelled by the user]"),
        "{}",
        out.content
    );
    assert!(out.is_error);
    assert!(started.elapsed() < Duration::from_secs(12));

    let out = f.run("print('again')").await;
    assert_eq!(out.content, "again\n[exit 0]");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_run_in_the_same_chat_is_refused() {
    let _serial = SERIAL.lock().await;
    let Some(rt) = runtime() else { return };
    let f = Fixture::new(&rt, 30);
    let spec = f.spec.clone();
    let thread = f.thread.clone();
    let (claimed_tx, claimed_rx) = tokio::sync::oneshot::channel();
    let first = tokio::spawn(async move {
        let guard = begin_run(&thread).expect("chat is free");
        claimed_tx.send(()).unwrap();
        run_python(
            spec,
            &guard,
            "import time\ntime.sleep(2)\nprint('first')",
            &[],
        )
        .await
    });
    claimed_rx.await.unwrap();
    assert_eq!(
        begin_run(&f.thread).err().as_deref(),
        Some("a python run is already in progress in this chat")
    );
    let out = first.await.unwrap().expect("first run");
    assert_eq!(out.content, "first\n[exit 0]");
}
