//! Whether the python tool can run on this machine.

use std::sync::OnceLock;

use mxc_sdk::v1;
use serde::Serialize;

/// The answer to "can the python tool run here", with a short English reason
/// when it cannot.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PythonStatus {
    pub available: bool,
    pub reason: Option<String>,
}

impl PythonStatus {
    fn yes() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }

    fn no(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
        }
    }
}

/// Turn what MXC reported into a verdict.
///
/// `supported` and `reason` come from `platform_support()`. `probe` is
/// `(tier, needs_dacl_augmentation)` from the process-container probe and exists
/// only on Windows (`None` elsewhere). On Windows the tool needs the base
/// container tier without DACL augmentation: the AppContainer tier would have to
/// rewrite the ACLs of the folders it mounts, which the app must not do to the
/// user's files.
fn judge(
    supported: bool,
    reason: Option<String>,
    probe: Option<(Option<&str>, Option<bool>)>,
) -> PythonStatus {
    if !supported {
        return PythonStatus::no(
            reason.unwrap_or_else(|| "MXC sandbox is not supported on this platform".to_string()),
        );
    }
    match probe {
        None | Some((Some("base-container"), Some(false))) => PythonStatus::yes(),
        Some((Some("base-container"), _)) => {
            PythonStatus::no("MXC base container would need DACL changes on this Windows build")
        }
        Some(_) => PythonStatus::no("MXC base container is not available on this Windows build"),
    }
}

/// Ask MXC once; the answer cannot change while the app runs.
pub fn status() -> PythonStatus {
    static STATUS: OnceLock<PythonStatus> = OnceLock::new();
    STATUS.get_or_init(detect).clone()
}

#[cfg(windows)]
fn detect() -> PythonStatus {
    use super::request::{build_request, RunSpec};

    let support = v1::platform_support();
    if !support.is_supported {
        return judge(false, support.reason, None);
    }
    // The tier depends on the machine, not on the request, but `probe` wants a
    // request to check against the host. Any small valid one will do; the
    // folders need not exist because nothing is run.
    let base = std::env::temp_dir();
    let request = build_request(&RunSpec {
        runtime: base.join("jan-python-probe-runtime"),
        workspace: base.join("jan-python-probe-workspace"),
        inputs: base.join("jan-python-probe-inputs"),
        timeout_s: 1,
    });
    let probe = match v1::probe(Some(&request)) {
        Ok(p) => (p.tier, p.needs_dacl_augmentation),
        Err(_) => (None, None),
    };
    judge(true, None, Some(probe))
}

#[cfg(not(windows))]
fn detect() -> PythonStatus {
    let support = v1::platform_support();
    judge(support.is_supported, support.reason, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unavailable(status: &PythonStatus) -> &str {
        assert!(!status.available, "expected unavailable: {status:?}");
        status.reason.as_deref().expect("a reason")
    }

    #[test]
    fn unix_supported_is_available() {
        let status = judge(true, None, None);
        assert!(status.available);
        assert_eq!(status.reason, None);
    }

    #[test]
    fn unsupported_platform_is_unavailable_with_mxc_reason() {
        let status = judge(false, Some("no bubblewrap".to_string()), None);
        assert_eq!(unavailable(&status), "no bubblewrap");
    }

    #[test]
    fn unsupported_platform_without_reason_still_explains() {
        let status = judge(false, None, None);
        assert!(!unavailable(&status).is_empty());
    }

    #[test]
    fn windows_base_container_without_dacl_is_available() {
        let status = judge(true, None, Some((Some("base-container"), Some(false))));
        assert!(status.available);
        assert_eq!(status.reason, None);
    }

    #[test]
    fn windows_appcontainer_is_unavailable() {
        let status = judge(true, None, Some((Some("appcontainer"), Some(false))));
        assert_eq!(
            unavailable(&status),
            "MXC base container is not available on this Windows build"
        );
    }

    #[test]
    fn windows_base_container_needing_dacl_is_unavailable() {
        let status = judge(true, None, Some((Some("base-container"), Some(true))));
        assert!(unavailable(&status).contains("DACL"));
    }

    #[test]
    fn windows_unknown_dacl_is_unavailable() {
        let status = judge(true, None, Some((Some("base-container"), None)));
        assert!(!status.available);
    }

    #[test]
    fn windows_failed_probe_is_unavailable() {
        let status = judge(true, None, Some((None, None)));
        assert!(!status.available);
    }

    #[test]
    fn unsupported_beats_a_good_probe() {
        let status = judge(
            false,
            Some("no".to_string()),
            Some((Some("base-container"), Some(false))),
        );
        assert!(!status.available);
    }

    #[test]
    fn status_is_decided_once() {
        let first = status();
        eprintln!("python status on this host: {first:?}");
        assert_eq!(first, status());
        assert_eq!(first.available, first.reason.is_none());
    }
}
