//! Save a file from a python run's workspace to a place the user picks.
//!
//! The relative path comes from the frontend, which is not trusted: only a regular file that
//! really lives inside the thread workspace may be read and copied.
//!
//! The file is opened when the user clicks Save, before the dialog opens, and the bytes come
//! from that handle. The workspace is writable by later (possibly prompt-injected) runs, so
//! re-opening the path after the dialog closes could follow a link swapped in meanwhile.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// The separators a relative path may use. On Windows both count; on Unix a backslash is an
/// ordinary character in a file name, so it must not be split on.
#[cfg(windows)]
const SEPARATORS: [char; 2] = ['/', '\\'];
#[cfg(not(windows))]
const SEPARATORS: [char; 1] = ['/'];

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Whether a path component is an ordinary file name on this OS.
///
/// Windows rewrites some names into others (`out.csv.` -> `out.csv`, `.. ` -> `..`), reaches
/// streams with `:` (`out.csv::$DATA`, `C:x`) and treats device names (`NUL`, `CON.txt`)
/// specially. None of these is a name the run could have listed, so they are all refused.
#[cfg(windows)]
fn is_plain_name(part: &str) -> bool {
    if part.contains(':') || part.ends_with([' ', '.']) {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|p| {
        stem.strip_prefix(p)
            .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
    });
    !reserved
}

#[cfg(not(windows))]
fn is_plain_name(_part: &str) -> bool {
    true
}

/// Resolve `relative` (as printed in a `[file: ...]` line, `/` separated; `\` too on Windows) to
/// a regular file inside `workspace`, or say why not.
///
/// The result is canonical (no links), so pass it on to [`save_with`] as it is.
pub fn resolve_workspace_file(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Err("The file path is empty.".to_string());
    }
    // The frontend's path is only ever relative: a leading separator (absolute or UNC), a drive
    // prefix, or `..` is never legitimate.
    if relative.starts_with(SEPARATORS) {
        return Err("The file path must be relative to the workspace.".to_string());
    }
    let mut parts = Vec::new();
    for part in relative.split(SEPARATORS) {
        match part {
            "" | "." => {}
            ".." => return Err("The file path must not contain '..'.".to_string()),
            p if !is_plain_name(p) => return Err("The file path is not valid.".to_string()),
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

/// The path the OS says an open file really lives at (links resolved), as the canonical form
/// `canonicalize` gives, so it can be compared with a path from [`resolve_workspace_file`].
#[cfg(any(target_os = "linux", target_os = "android"))]
fn handle_path(file: &File) -> io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
fn handle_path(file: &File) -> io::Result<PathBuf> {
    use nix::libc;
    use std::ffi::OsStr;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = [0u8; libc::PATH_MAX as usize];
    // SAFETY: `F_GETPATH` writes a NUL-terminated path of at most PATH_MAX bytes into `buf`.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(OsStr::from_bytes(&buf[..len])))
}

#[cfg(windows)]
fn handle_path(file: &File) -> io::Result<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };
    let handle = file.as_raw_handle();
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `handle` is open for the duration of the call; `buf` has `buf.len()` units.
        let n = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buf.as_mut_ptr(),
                buf.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if n == 0 {
            return Err(io::Error::last_os_error());
        }
        if n < buf.len() {
            return Ok(PathBuf::from(OsString::from_wide(&buf[..n])));
        }
        // Too small: `n` is the size needed, including the terminating NUL.
        buf.resize(n, 0);
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    windows
)))]
fn handle_path(_file: &File) -> io::Result<PathBuf> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Unix file systems compare paths exactly, Windows ones ignore case.
fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Open `source` for reading and check that the handle really is the regular file the path
/// names. `source` must be a path from [`resolve_workspace_file`]: canonical, so no component is
/// a link and, being under the workspace, the file is inside it. `after_check` runs between the
/// path check and the open (a test seam; a sandboxed run can swap things at exactly that point).
fn open_verified(source: &Path, after_check: impl FnOnce()) -> Result<File, String> {
    let gone = || "The file is no longer in the workspace.".to_string();
    // A path that was link-free when resolved still is; a parent swapped for a link is not.
    let canonical = source.canonicalize().map_err(|_| gone())?;
    if !same_path(&canonical, source) {
        return Err(gone());
    }
    after_check();
    let file = OpenOptions::new()
        .read(true)
        .open(&canonical)
        .map_err(|_| gone())?;
    // The check above and the open are not atomic: a parent folder swapped for a link in
    // between would make `open` follow it out of the workspace. Ask the OS where the open handle
    // really is; that is the only answer a swap after this point cannot change.
    let actual = handle_path(&file).map_err(|_| gone())?;
    if !same_path(&actual, &canonical) {
        return Err(gone());
    }
    let opened = file.metadata().map_err(|_| gone())?;
    if !opened.is_file() {
        return Err("The path is not a file.".to_string());
    }
    // Extra guard: the handle is the very file the path names now.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = std::fs::symlink_metadata(&canonical).map_err(|_| gone())?;
        if !named.is_file() || (opened.dev(), opened.ino()) != (named.dev(), named.ino()) {
            return Err("The file changed while it was being opened.".to_string());
        }
    }
    Ok(file)
}

/// Write `from` to a temporary sibling of `dest` and move it over `dest`, so `dest` is never
/// truncated in place (it may be a hard link to the source) and a failure leaves nothing behind.
fn write_beside(from: &mut File, dest: &Path) -> io::Result<()> {
    let dir = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let temp = dir.join(format!(".jan-save-{}-{n}.tmp", std::process::id()));
    let result = (|| {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        io::copy(from, &mut out)?;
        out.flush()?;
        drop(out);
        std::fs::rename(&temp, dest)
    })();
    if result.is_err() {
        // Best effort: the error being reported is the one that matters.
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Copy `source` to the place `pick` chooses. `pick` gets the file's name and returns the
/// destination, or `None` when the user cancels. Returns the destination that was written.
///
/// `source` is opened before `pick` runs, so the content saved is the content at click time.
pub fn save_with(
    source: &Path,
    pick: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    save_inner(source, pick, || {})
}

/// [`save_with`], plus the test seam of [`open_verified`].
fn save_inner(
    source: &Path,
    pick: impl FnOnce(&str) -> Option<PathBuf>,
    after_check: impl FnOnce(),
) -> Result<Option<PathBuf>, String> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "The file has no name.".to_string())?;
    let mut file = open_verified(source, after_check)?;
    let Some(dest) = pick(&name) else {
        return Ok(None);
    };
    // Saving a file onto itself changes nothing.
    if let (Ok(a), Ok(b)) = (source.canonicalize(), dest.canonicalize()) {
        if a == b {
            return Ok(Some(dest));
        }
    }
    write_beside(&mut file, &dest).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(Some(dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    fn reject_reason(ws: &Path, rel: &str) -> String {
        match resolve_workspace_file(ws, rel) {
            Ok(p) => panic!("{rel:?} must be rejected, got {}", p.display()),
            Err(e) => e,
        }
    }

    #[test]
    fn resolves_files_inside_the_workspace() {
        let (_root, ws) = workspace();
        let canon_ws = ws.canonicalize().unwrap();
        let mut cases = vec![
            ("out.csv", "out.csv"),
            ("sub/a.txt", "sub/a.txt"),
            ("./out.csv", "out.csv"),
            ("sub//a.txt", "sub/a.txt"),
        ];
        if cfg!(windows) {
            cases.push(("sub\\a.txt", "sub/a.txt"));
        }
        for (rel, expected) in cases {
            let got = resolve_workspace_file(&ws, rel).unwrap_or_else(|e| panic!("{rel}: {e}"));
            assert_eq!(got, canon_ws.join(expected), "{rel}");
            assert!(got.is_file());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_names_with_a_colon_or_a_backslash_are_ordinary() {
        let (root, ws) = workspace();
        root.write("ws/report 12:30.csv", "t");
        root.write("ws/back\\slash.csv", "b");
        root.write("ws/dir:x/in.txt", "d");
        for rel in ["report 12:30.csv", "back\\slash.csv", "dir:x/in.txt"] {
            let got = resolve_workspace_file(&ws, rel).unwrap_or_else(|e| panic!("{rel}: {e}"));
            assert!(got.is_file(), "{rel}");
        }
        // A backslash is not a separator, so this is a missing file, not `..`.
        assert!(reject_reason(&ws, "..\\secret.txt").contains("not found"));
    }

    #[test]
    fn rejects_empty_and_current_dir_only() {
        let (_root, ws) = workspace();
        for rel in ["", "   ", ".", "./", "/"] {
            assert!(resolve_workspace_file(&ws, rel).is_err(), "{rel:?}");
        }
        #[cfg(windows)]
        assert!(resolve_workspace_file(&ws, "\\").is_err());
    }

    #[test]
    fn rejects_parent_components_even_when_they_come_back_inside() {
        let (_root, ws) = workspace();
        for rel in [
            "../secret.txt",
            "sub/../../secret.txt",
            "sub/../out.csv",
            "..",
        ] {
            assert!(reject_reason(&ws, rel).contains("'..'"), "{rel}");
        }
        #[cfg(windows)]
        assert!(reject_reason(&ws, "..\\secret.txt").contains("'..'"));
    }

    #[test]
    fn rejects_absolute_paths() {
        let (root, ws) = workspace();
        let abs = root.path().join("secret.txt").to_string_lossy().to_string();
        for rel in ["/etc/passwd", "//server/share/x"] {
            assert!(reject_reason(&ws, rel).contains("relative"), "{rel}");
        }
        // A real absolute path never resolves, whatever the OS.
        assert!(resolve_workspace_file(&ws, &abs).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_path_forms() {
        let (_root, ws) = workspace();
        // Each line: the input and a piece of the reason.
        for (rel, reason) in [
            ("\\etc\\passwd", "relative"),
            ("C:\\x", "not valid"),
            ("C:/x", "not valid"),
            ("C:x", "not valid"),
            ("\\\\server\\share\\x", "relative"),
            ("\\\\?\\C:\\x", "relative"),
            ("\\\\.\\NUL", "relative"),
            ("out.csv::$DATA", "not valid"),
            ("out.csv:s", "not valid"),
            ("sub/a.txt:stream", "not valid"),
            ("NUL", "not valid"),
            ("nul.txt", "not valid"),
            ("sub/CON", "not valid"),
            ("COM1", "not valid"),
            ("lpt9.log", "not valid"),
            (".. /secret.txt", "not valid"),
            ("out.csv.", "not valid"),
            ("out.csv ", "not valid"),
            ("sub./a.txt", "not valid"),
        ] {
            let got = reject_reason(&ws, rel);
            assert!(got.contains(reason), "{rel:?}: {got}");
        }
        // Names that merely look similar are fine.
        accepts_lookalike_names(&ws);
    }

    #[cfg(windows)]
    fn accepts_lookalike_names(ws: &Path) {
        fs::write(ws.join("nullable.txt"), "x").unwrap();
        fs::write(ws.join("com10.txt"), "x").unwrap();
        assert!(resolve_workspace_file(ws, "nullable.txt").is_ok());
        assert!(resolve_workspace_file(ws, "com10.txt").is_ok());
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
    fn save_onto_a_hard_link_of_the_source_does_not_truncate_the_source() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        let alias = root.path().join("alias.txt");
        fs::hard_link(&source, &alias).unwrap();
        save_with(&source, |_| Some(alias.clone())).unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "hello");
        assert_eq!(fs::read_to_string(&alias).unwrap(), "hello");
    }

    fn temp_leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("jan-save"))
            .collect()
    }

    #[test]
    fn save_reports_a_failed_copy() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "out.csv").unwrap();
        let dest = root.path().join("no-such-dir").join("x.csv");
        let err = save_with(&source, |_| Some(dest.clone())).unwrap_err();
        assert!(err.starts_with("Could not save the file"), "{err}");
    }

    #[test]
    fn a_failed_write_leaves_no_temp_file_behind() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "out.csv").unwrap();
        // A folder cannot be replaced by a file, so the final move fails after the copy.
        let dest = root.path().join("taken");
        fs::create_dir_all(dest.join("inner")).unwrap();
        let err = save_with(&source, |_| Some(dest.clone())).unwrap_err();
        assert!(err.starts_with("Could not save the file"), "{err}");
        assert!(dest.join("inner").is_dir());
        assert_eq!(temp_leftovers(root.path()), Vec::<String>::new());
    }

    #[test]
    fn save_writes_the_content_the_file_had_when_it_was_opened() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        let dest = root.path().join("saved.txt");
        // While the dialog is open, the file is moved away and another one takes its place.
        save_with(&source, |_| {
            fs::rename(&source, source.with_extension("old")).unwrap();
            fs::write(&source, "swapped").unwrap();
            Some(dest.clone())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_swapped_in_while_the_dialog_is_open_is_not_followed() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        let dest = root.path().join("saved.txt");
        save_with(&source, |_| {
            fs::remove_file(&source).unwrap();
            std::os::unix::fs::symlink(root.path().join("secret.txt"), &source).unwrap();
            Some(dest.clone())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_swapped_in_before_the_save_is_refused() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        fs::remove_file(&source).unwrap();
        std::os::unix::fs::symlink(root.path().join("secret.txt"), &source).unwrap();
        let mut asked = false;
        let err = save_with(&source, |_| {
            asked = true;
            Some(root.path().join("saved.txt"))
        })
        .unwrap_err();
        assert!(!asked, "the dialog must not open for a swapped file: {err}");
        assert!(!root.path().join("saved.txt").exists());
    }

    /// Make `link` a folder link to `target`: a symlink on Unix, a junction (no admin rights) on
    /// Windows.
    fn link_dir(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(made.status.success(), "mklink failed");
        }
    }

    #[test]
    fn a_parent_swapped_for_a_link_between_the_check_and_the_open_is_refused() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        // The folder `sub` is replaced by a link to a folder outside the workspace holding a
        // file of the same name, after the path check and before the open.
        root.write("elsewhere/a.txt", "other");
        let dest = root.path().join("saved.txt");
        let mut asked = false;
        let err = save_inner(
            &source,
            |_| {
                asked = true;
                Some(dest.clone())
            },
            || {
                fs::rename(ws.join("sub"), ws.join("sub.old")).unwrap();
                link_dir(&ws.join("sub"), &root.path().join("elsewhere"));
            },
        )
        .unwrap_err();
        assert!(err.contains("no longer"), "{err}");
        assert!(!asked, "the dialog must not open for a swapped parent");
        assert!(!dest.exists(), "nothing may be written");
    }

    #[test]
    fn the_open_handle_reports_the_path_it_was_opened_by() {
        let (_root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        let file = File::open(&source).unwrap();
        assert!(same_path(&handle_path(&file).unwrap(), &source));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_before_the_save_is_refused() {
        let (root, ws) = workspace();
        let source = resolve_workspace_file(&ws, "sub/a.txt").unwrap();
        // `sub` becomes a link to a folder holding a same-named file elsewhere.
        root.write("elsewhere/a.txt", "other");
        fs::rename(ws.join("sub"), ws.join("sub.old")).unwrap();
        std::os::unix::fs::symlink(root.path().join("elsewhere"), ws.join("sub")).unwrap();
        let err = save_with(&source, |_| Some(root.path().join("saved.txt"))).unwrap_err();
        assert!(err.contains("no longer"), "{err}");
        assert!(!root.path().join("saved.txt").exists());
    }
}
