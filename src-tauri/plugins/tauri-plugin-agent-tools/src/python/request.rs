//! The sandbox request for one python run.

use std::path::{Path, PathBuf};

use mxc_sdk::v1::{
    ContainerRequest, FilesystemPolicy, NetworkAction, NetworkEgressPolicy, NetworkIngressPolicy,
    NetworkPolicy, UiPolicy,
};

use super::runtime::python_executable;

/// Everything that decides what a run may touch.
#[derive(Debug, Clone)]
pub struct RunSpec {
    /// The runtime folder (read-only inside the sandbox).
    pub runtime: PathBuf,
    /// The thread's workspace (read-write; also the working directory).
    pub workspace: PathBuf,
    /// The thread's staged attachments (read-only).
    pub inputs: PathBuf,
    /// Already clamped with `clamp_timeout`.
    pub timeout_s: u32,
}

/// The time a run gets when the model does not ask for one.
pub const DEFAULT_TIMEOUT_S: u32 = 30;
/// The longest a run may take, however much is asked for.
pub const MAX_TIMEOUT_S: u32 = 300;

/// The run time in seconds: 30 when unset, otherwise kept within 1..=300.
pub fn clamp_timeout(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_S)
        .clamp(1, MAX_TIMEOUT_S)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The interpreter path as the first word of the command line.
///
/// Windows: MXC hands the line to `CreateProcessW`, where a double-quoted path
/// is one argument (a Windows path cannot contain `"`).
#[cfg(windows)]
fn quote_command_path(path: &Path) -> String {
    format!("\"{}\"", path_string(path))
}

/// The interpreter path as the first word of the command line.
///
/// Unix: Bubblewrap and Seatbelt run the line with `sh -c`, where `$`, `` ` ``,
/// `\` and `"` stay special inside double quotes. Single quotes make the path
/// literal; a `'` in it is written as `'\''` (close, escaped quote, reopen).
#[cfg(not(windows))]
fn quote_command_path(path: &Path) -> String {
    format!("'{}'", path_string(path).replace('\'', r"'\''"))
}

/// The sandbox request for one run: the script arrives on stdin, the workspace
/// is the only writable place, the runtime and inputs are read-only, and there
/// is no network and no UI.
///
/// The environment is explicit and never inherited, because the app's own
/// environment can hold API keys.
pub fn build_request(spec: &RunSpec) -> ContainerRequest {
    let python = python_executable(&spec.runtime);
    // The interpreter path is quoted: the data folder may contain spaces.
    let mut request = ContainerRequest::new(format!("{} -I -B -", quote_command_path(&python)));
    let workspace = path_string(&spec.workspace);
    let inputs = path_string(&spec.inputs);

    request.filesystem = Some(FilesystemPolicy {
        readwrite_paths: vec![workspace.clone()],
        readonly_paths: vec![path_string(&spec.runtime), inputs.clone()],
        ..Default::default()
    });
    request.network = Some(NetworkPolicy {
        egress: Some(NetworkEgressPolicy {
            default: Some(NetworkAction::Deny),
            ..Default::default()
        }),
        ingress: Some(NetworkIngressPolicy {
            default: Some(NetworkAction::Deny),
            host_loopback: Some(NetworkAction::Deny),
        }),
        ..Default::default()
    });
    request.ui = Some(UiPolicy::default());
    request.timeout_ms = Some(spec.timeout_s.saturating_mul(1000));
    request.working_directory = Some(workspace.clone());

    let mut env = vec![
        ("JAN_INPUTS".to_string(), inputs),
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
    ];
    if cfg!(windows) {
        // MXC refuses a Windows process container whose explicit environment
        // lacks these two. `SystemRoot` is not a secret; the profile folder is
        // pointed at the workspace so nothing is written under the real profile.
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        env.push(("SYSTEMROOT".to_string(), system_root));
        env.push(("LOCALAPPDATA".to_string(), workspace));
    } else {
        env.push(("HOME".to_string(), workspace));
        env.push(("LANG".to_string(), "C.UTF-8".to_string()));
    }
    request.environment = Some(env);
    request.inherit_default_environment = Some(false);
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn spec() -> RunSpec {
        RunSpec {
            runtime: PathBuf::from("data").join("python-runtime").join("x y"),
            workspace: PathBuf::from("data").join("ws"),
            inputs: PathBuf::from("data").join("in"),
            timeout_s: 30,
        }
    }

    #[test]
    fn clamp_timeout_defaults_and_bounds() {
        assert_eq!(clamp_timeout(None), 30);
        assert_eq!(clamp_timeout(Some(0)), 1);
        assert_eq!(clamp_timeout(Some(45)), 45);
        assert_eq!(clamp_timeout(Some(301)), 300);
        assert_eq!(clamp_timeout(Some(u32::MAX)), 300);
    }

    #[test]
    fn environment_is_exactly_the_allowed_keys_and_ignores_the_host() {
        // A unique name, so no other test can observe or race this variable.
        let name = format!("JAN_TEST_SECRET_{}", std::process::id());
        // SAFETY: edition 2021, where `set_var` is a safe fn; the name is unique
        // to this test, so no other thread reads it.
        std::env::set_var(&name, "x");
        let request = build_request(&spec());
        std::env::remove_var(&name);

        let env = request.environment.expect("explicit environment");
        let keys: BTreeSet<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        let expected: BTreeSet<&str> = if cfg!(windows) {
            [
                "JAN_INPUTS",
                "PYTHONUTF8",
                "PYTHONIOENCODING",
                "SYSTEMROOT",
                "LOCALAPPDATA",
            ]
            .into()
        } else {
            [
                "JAN_INPUTS",
                "PYTHONUTF8",
                "PYTHONIOENCODING",
                "HOME",
                "LANG",
            ]
            .into()
        };
        assert_eq!(keys, expected);
        assert_eq!(env.len(), keys.len(), "no duplicate keys");
        assert!(!keys.contains(name.as_str()));
        assert_eq!(request.inherit_default_environment, Some(false));

        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        let s = spec();
        assert_eq!(get("JAN_INPUTS"), Some(s.inputs.to_str().unwrap()));
        assert_eq!(get("PYTHONUTF8"), Some("1"));
        assert_eq!(get("PYTHONIOENCODING"), Some("utf-8"));
        let home = if cfg!(windows) {
            "LOCALAPPDATA"
        } else {
            "HOME"
        };
        assert_eq!(get(home), Some(s.workspace.to_str().unwrap()));
        if cfg!(windows) {
            assert!(!get("SYSTEMROOT").unwrap().is_empty());
        } else {
            assert_eq!(get("LANG"), Some("C.UTF-8"));
        }
    }

    #[test]
    fn network_is_denied_everywhere() {
        let request = build_request(&spec());
        let network = request.network.expect("network policy");
        assert_eq!(network.egress.unwrap().default, Some(NetworkAction::Deny));
        let ingress = network.ingress.unwrap();
        assert_eq!(ingress.default, Some(NetworkAction::Deny));
        assert_eq!(ingress.host_loopback, Some(NetworkAction::Deny));
    }

    #[test]
    fn only_the_workspace_is_writable() {
        let s = spec();
        let request = build_request(&s);
        let fs = request.filesystem.expect("filesystem policy");
        assert_eq!(fs.readwrite_paths, vec![s.workspace.to_str().unwrap()]);
        assert_eq!(
            fs.readonly_paths,
            vec![s.runtime.to_str().unwrap(), s.inputs.to_str().unwrap()]
        );
    }

    #[test]
    fn command_quotes_the_interpreter_and_reads_the_script_from_stdin() {
        let s = spec();
        let request = build_request(&s);
        let python = crate::python::runtime::python_executable(&s.runtime);
        let quoted = if cfg!(windows) {
            format!("\"{}\"", python.to_str().unwrap())
        } else {
            format!("'{}'", python.to_str().unwrap())
        };
        assert_eq!(request.command, format!("{quoted} -I -B -"));
        assert!(request.command.contains("x y"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_is_double_quoted() {
        let path = Path::new(r"C:\Users\a b\Jan\python.exe");
        assert_eq!(quote_command_path(path), r#""C:\Users\a b\Jan\python.exe""#);
    }

    #[cfg(unix)]
    #[test]
    fn unix_path_is_single_quoted_with_quotes_escaped() {
        let q = |s: &str| quote_command_path(Path::new(s));
        assert_eq!(q("/home/u/My Jan/python3"), "'/home/u/My Jan/python3'");
        assert_eq!(q("/u/$work/`id`/python3"), "'/u/$work/`id`/python3'");
        assert_eq!(q(r#"/u/My "Jan"/python3"#), r#"'/u/My "Jan"/python3'"#);
        assert_eq!(q(r"/u/a\b/python3"), r"'/u/a\b/python3'");
        assert_eq!(q("/u/it's/python3"), r"'/u/it'\''s/python3'");
    }

    /// The shell turns the quoted text back into exactly the original path.
    #[cfg(unix)]
    #[test]
    fn unix_quoting_round_trips_through_sh() {
        let paths = [
            "/home/u/My Jan/python3",
            "/u/$work/python3",
            "/u/$(echo hi)/python3",
            "/u/`echo hi`/python3",
            r#"/u/My "Jan"/python3"#,
            r"/u/a\b\n/python3",
            "/u/it's/python3",
            "/u/'''/python3",
            "/u/a;b&c|d>e/python3",
        ];
        for original in paths {
            let line = format!("printf %s {}", quote_command_path(Path::new(original)));
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(&line)
                .output()
                .expect("sh");
            assert!(out.status.success(), "{line}");
            assert_eq!(String::from_utf8_lossy(&out.stdout), original, "{line}");
        }
    }

    #[test]
    fn limits_and_directory() {
        let mut s = spec();
        s.timeout_s = 7;
        let request = build_request(&s);
        assert_eq!(request.timeout_ms, Some(7000));
        assert_eq!(
            request.working_directory.as_deref(),
            Some(s.workspace.to_str().unwrap())
        );
        assert!(request.ui.is_some());
    }
}
