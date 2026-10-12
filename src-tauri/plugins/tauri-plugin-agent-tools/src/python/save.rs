//! Save a file from a python run's workspace to a place the user picks.
//!
//! The relative path comes from the frontend, which is not trusted: only a regular file that
//! really lives inside the thread workspace may be read and copied.

use std::path::{Path, PathBuf};

/// Both separators count, whatever the host OS uses.
const SEPARATORS: [char; 2] = ['/', '\\'];

/// Resolve `relative` (as printed in a `[file: ...]` line, `/` or `\` separated) to a regular
/// file inside `workspace`, or say why not.
pub fn resolve_workspace_file(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Err("The file path is empty.".to_string());
    }
    // The frontend's path is only ever relative: a leading separator, a drive or UNC prefix, or `..` is never legitimate.
    if relative.starts_with(SEPARATORS) {
        return Err("The file path must be relative to the workspace.".to_string());
    }
    let mut parts = Vec::new();
    for part in relative.split(SEPARATORS) {
        match part {
            "" | "." => {}
            ".." => return Err("The file path must not contain '..'.".to_string()),
            // A drive letter (`C:x`) or an NTFS alternate data stream (`a.txt:s`).
            p if p.contains(':') => return Err("The file path is not valid.".to_string()),
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err("The file path is empty.".to_string());
    }
    let mut candidate = workspace.to_path_buf();
    candidate.extend(&parts);
    let root = workspace
        .canonicalize()
        .map_err(|_| "The workspace folder is not available.".to_string())?;
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "The file was not found in the workspace.".to_string())?;
    // Symlinks and junctions are followed by `canonicalize`, so this catches ones pointing out.
    if !resolved.starts_with(&root) {
        return Err("The file is outside the workspace.".to_string());
    }
    if !resolved.is_file() {
        return Err("The path is not a file.".to_string());
    }
    Ok(resolved)
}

/// Copy `source` to the place `pick` chooses. `pick` gets the file's name and returns the
/// destination, or `None` when the user cancels. Returns the destination that was written.
pub fn save_with(
    source: &Path,
    pick: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "The file has no name.".to_string())?;
    let Some(dest) = pick(&name) else {
        return Ok(None);
    };
    // Copying a file onto itself would truncate it first.
    if let (Ok(a), Ok(b)) = (source.canonicalize(), dest.canonicalize()) {
        if a == b {
            return Ok(Some(dest));
        }
    }
    std::fs::copy(source, &dest).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(Some(dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A scratch directory under the host temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir =
                std::env::temp_dir().join(format!("jan_save_test_{}_{}", std::process::id(), n));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A workspace with `out.csv` and `sub/a.txt`, plus a secret file beside it.
    fn workspace() -> (Scratch, PathBuf) {
        let root = Scratch::new();
        root.write("secret.txt", "secret");
        root.write("ws/out.csv", "a,b\n1,2\n");
        root.write("ws/sub/a.txt", "hello");
        let ws = root.path().join("ws");
        (root, ws)
    }

    #[test]
    fn resolves_files_inside_the_workspace() {
        let (_root, ws) = workspace();
        let canon_ws = ws.canonicalize().unwrap();
        for (rel, expected) in [
            ("out.csv", "out.csv"),
            ("sub/a.txt", "sub/a.txt"),
            ("sub\\a.txt", "sub/a.txt"),
            ("./out.csv", "out.csv"),
            ("sub//a.txt", "sub/a.txt"),
        ] {
            let got = resolve_workspace_file(&ws, rel).unwrap_or_else(|e| panic!("{rel}: {e}"));
            assert_eq!(got, canon_ws.join(expected), "{rel}");
            assert!(got.is_file());
        }
    }

    #[test]
    fn rejects_empty_and_current_dir_only() {
        let (_root, ws) = workspace();
        for rel in ["", ".", "./", "/", "\\"] {
            assert!(resolve_workspace_file(&ws, rel).is_err(), "{rel:?}");
        }
    }

    #[test]
    fn rejects_parent_components_even_when_they_come_back_inside() {
        let (_root, ws) = workspace();
        for rel in [
            "../secret.txt",
            "..\\secret.txt",
            "sub/../../secret.txt",
            "sub/../out.csv",
            "..",
        ] {
            assert!(resolve_workspace_file(&ws, rel).is_err(), "{rel}");
        }
    }

    #[test]
    fn rejects_absolute_and_prefixed_paths() {
        let (root, ws) = workspace();
        let abs = root.path().join("secret.txt").to_string_lossy().to_string();
        for rel in [
            "/etc/passwd",
            "\\etc\\passwd",
            "C:\\x",
            "C:/x",
            "C:x",
            "\\\\server\\share\\x",
            "//server/share/x",
            "sub/a.txt:stream",
            abs.as_str(),
        ] {
            assert!(resolve_workspace_file(&ws, rel).is_err(), "{rel}");
        }
    }

    #[test]
    fn rejects_directories_and_missing_files() {
        let (_root, ws) = workspace();
        assert!(resolve_workspace_file(&ws, "sub").is_err());
        assert!(resolve_workspace_file(&ws, "sub/").is_err());
        assert!(resolve_workspace_file(&ws, "nope.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_points_outside_the_workspace() {
        let (root, ws) = workspace();
        std::os::unix::fs::symlink(root.path().join("secret.txt"), ws.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(root.path(), ws.join("dirlink")).unwrap();
        assert!(resolve_workspace_file(&ws, "link.txt").is_err());
        assert!(resolve_workspace_file(&ws, "dirlink/secret.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_a_symlink_that_stays_inside_the_workspace() {
        let (_root, ws) = workspace();
        std::os::unix::fs::symlink(ws.join("out.csv"), ws.join("alias.csv")).unwrap();
        let got = resolve_workspace_file(&ws, "alias.csv").unwrap();
        assert_eq!(got, ws.canonicalize().unwrap().join("out.csv"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_junction_that_points_outside_the_workspace() {
        let (root, ws) = workspace();
        // `mklink /J` needs no admin rights.
        let link = ws.join("jlink");
        let made = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(root.path())
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink failed");
        assert!(link.join("secret.txt").is_file());
        assert!(resolve_workspace_file(&ws, "jlink/secret.txt").is_err());
        assert!(resolve_workspace_file(&ws, "jlink\\secret.txt").is_err());
        // The real files still resolve.
        assert!(resolve_workspace_file(&ws, "out.csv").is_ok());
    }

    #[test]
    fn save_copies_to_the_picked_place_and_passes_the_file_name() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        let dest = root.path().join("saved.txt");
        let mut seen = String::new();
        let got = save_with(&source, |name| {
            seen = name.to_string();
            Some(dest.clone())
        })
        .unwrap();
        assert_eq!(seen, "a.txt");
        assert_eq!(got, Some(dest.clone()));
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
        assert_eq!(fs::read_to_string(&source).unwrap(), "hello");
    }

    #[test]
    fn save_overwrites_an_existing_destination() {
        let (root, ws) = workspace();
        root.write("saved.txt", "old content that is longer");
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        let dest = root.path().join("saved.txt");
        save_with(&source, |_| Some(dest.clone())).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
    }

    #[test]
    fn save_does_nothing_when_the_user_cancels() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "out.csv").unwrap();
        assert_eq!(save_with(&source, |_| None).unwrap(), None);
        assert!(!root.path().join("saved.txt").exists());
    }

    #[test]
    fn save_onto_the_source_itself_keeps_the_file() {
        let (_root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        // Same file reached by a different spelling of the path.
        let same = ws.join("sub").join("..").join("sub").join("a.txt");
        let got = save_with(&source, |_| Some(same.clone())).unwrap();
        assert_eq!(got, Some(same));
        assert_eq!(fs::read_to_string(&source).unwrap(), "hello");
    }

    #[test]
    fn save_reports_a_failed_copy() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "out.csv").unwrap();
        let dest = root.path().join("no-such-dir").join("x.csv");
        let err = save_with(&source, |_| Some(dest.clone())).unwrap_err();
        assert!(!err.is_empty());
    }
}
