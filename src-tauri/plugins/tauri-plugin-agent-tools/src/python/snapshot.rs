//! Before/after comparison of a run's workspace, to list the files it created or changed.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Relative path (always `/`-separated) -> (size in bytes, modified time).
pub type Snapshot = BTreeMap<String, (u64, SystemTime)>;

/// The most files a result lists; the rest are only counted.
pub const MAX_LISTED_FILES: usize = 50;

/// A file that is new or different after a run.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub size: u64,
}

/// Record the size and modified time of every file under `dir` (hidden files
/// included). Symlinks and junctions are skipped, not followed, so the walk can
/// neither leave `dir` nor loop. Only directory listings are read (no file
/// contents), so this stays cheap on large folders.
///
/// The run being compared may still be changing the folder while it is walked,
/// so below `dir` anything that cannot be read (removed, replaced, locked,
/// delete-pending, permission changed) is left out of the snapshot instead of
/// failing it. Only an error reading `dir` itself is returned.
pub fn snapshot(dir: &Path) -> std::io::Result<Snapshot> {
    walk(dir, &mut |_| {})
}

/// `snapshot`, calling `before_read_dir` with each subfolder just before it is
/// listed (a seam for tests to change the folder at that exact point).
fn walk(dir: &Path, before_read_dir: &mut dyn FnMut(&Path)) -> std::io::Result<Snapshot> {
    let mut out = Snapshot::new();
    let mut pending = Vec::new();
    // The root must be readable; a problem there is the caller's to see.
    scan_dir(dir, "", &mut pending, &mut out)?;
    while let Some((path, prefix)) = pending.pop() {
        before_read_dir(&path);
        // Best effort: an unreadable subfolder is simply absent.
        let _ = scan_dir(&path, &prefix, &mut pending, &mut out);
    }
    Ok(out)
}

/// List one folder: files go into `out`, subfolders onto `pending`. Entries
/// whose own read fails are skipped; only failing to open the listing is an error.
fn scan_dir(
    path: &Path,
    prefix: &str,
    pending: &mut Vec<(PathBuf, String)>,
    out: &mut Snapshot,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(path)? {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = format!("{prefix}{name}");
        if file_type.is_dir() {
            pending.push((entry.path(), format!("{rel}/")));
        } else if file_type.is_file() {
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            out.insert(rel, (meta.len(), modified));
        }
    }
    Ok(())
}

/// Files in `after` that are not in `before`, or whose size or modified time
/// differs, in path order. Deleted files are not reported.
pub fn changed(before: &Snapshot, after: &Snapshot) -> Vec<ChangedFile> {
    after
        .iter()
        .filter(|(path, stat)| before.get(*path) != Some(*stat))
        .map(|(path, (size, _))| ChangedFile {
            path: path.clone(),
            size: *size,
        })
        .collect()
}

/// The summed size in bytes of every file in the snapshot.
pub fn total_size(s: &Snapshot) -> u64 {
    s.values().map(|(size, _)| size).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A scratch directory under the host temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "jan_snapshot_test_{}_{}",
                std::process::id(),
                n
            ));
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

        /// Pin a file's modified time, so a test does not depend on the clock's tick.
        fn set_mtime(&self, rel: &str, t: SystemTime) {
            let f = fs::OpenOptions::new()
                .write(true)
                .open(self.0.join(rel))
                .unwrap();
            f.set_modified(t).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn changed_paths(before: &Snapshot, after: &Snapshot) -> Vec<String> {
        changed(before, after).into_iter().map(|c| c.path).collect()
    }

    #[test]
    fn changed_lists_new_and_rewritten_files_only() {
        let s = Scratch::new();
        s.write("keep.txt", "same");
        s.write("rewrite.txt", "old");
        s.write("gone.txt", "bye");
        let base = SystemTime::now() - Duration::from_secs(1000);
        for f in ["keep.txt", "rewrite.txt", "gone.txt"] {
            s.set_mtime(f, base);
        }
        let before = snapshot(s.path()).unwrap();

        s.write("rewrite.txt", "much longer content");
        s.write("new.txt", "hello");
        fs::remove_file(s.path().join("gone.txt")).unwrap();
        let after = snapshot(s.path()).unwrap();

        assert_eq!(
            changed(&before, &after),
            vec![
                ChangedFile {
                    path: "new.txt".to_string(),
                    size: 5
                },
                ChangedFile {
                    path: "rewrite.txt".to_string(),
                    size: 19
                },
            ]
        );
    }

    #[test]
    fn rewrite_with_same_size_is_seen_through_the_modified_time() {
        let s = Scratch::new();
        s.write("a.txt", "abc");
        let base = SystemTime::now() - Duration::from_secs(1000);
        s.set_mtime("a.txt", base);
        let before = snapshot(s.path()).unwrap();

        s.write("a.txt", "xyz");
        s.set_mtime("a.txt", base + Duration::from_secs(10));
        let after = snapshot(s.path()).unwrap();

        assert_eq!(changed_paths(&before, &after), vec!["a.txt"]);
    }

    #[test]
    fn rewrite_with_same_mtime_is_seen_through_the_size() {
        let s = Scratch::new();
        s.write("a.txt", "abc");
        let base = SystemTime::now() - Duration::from_secs(1000);
        s.set_mtime("a.txt", base);
        let before = snapshot(s.path()).unwrap();

        s.write("a.txt", "abcdef");
        s.set_mtime("a.txt", base);
        let after = snapshot(s.path()).unwrap();

        assert_eq!(changed_paths(&before, &after), vec!["a.txt"]);
    }

    #[test]
    fn untouched_folder_has_no_changes() {
        let s = Scratch::new();
        s.write("a.txt", "abc");
        s.write("sub/b.txt", "def");
        let before = snapshot(s.path()).unwrap();
        let after = snapshot(s.path()).unwrap();
        assert!(changed(&before, &after).is_empty());
    }

    #[test]
    fn nested_files_use_forward_slashes_and_hidden_files_count() {
        let s = Scratch::new();
        s.write("sub/deeper/a.txt", "12345");
        s.write(".hidden", "1");
        s.write("sub/.also", "12");
        let snap = snapshot(s.path()).unwrap();
        let keys: Vec<&str> = snap.keys().map(String::as_str).collect();
        assert_eq!(keys, vec![".hidden", "sub/.also", "sub/deeper/a.txt"]);
        assert_eq!(snap["sub/deeper/a.txt"].0, 5);
    }

    #[test]
    fn changed_is_in_path_order() {
        let s = Scratch::new();
        let before = snapshot(s.path()).unwrap();
        s.write("b.txt", "1");
        s.write("a/z.txt", "1");
        s.write("a.txt", "1");
        let after = snapshot(s.path()).unwrap();
        assert_eq!(
            changed_paths(&before, &after),
            vec!["a.txt", "a/z.txt", "b.txt"]
        );
    }

    #[test]
    fn total_size_sums_every_file() {
        let s = Scratch::new();
        s.write("a.txt", "12345");
        s.write("sub/b.txt", "123");
        s.write("sub/deeper/c.txt", "12");
        let snap = snapshot(s.path()).unwrap();
        assert_eq!(total_size(&snap), 10);
        assert_eq!(total_size(&Snapshot::new()), 0);
    }

    #[test]
    fn empty_folder_gives_an_empty_snapshot() {
        let s = Scratch::new();
        fs::create_dir_all(s.path().join("empty")).unwrap();
        assert!(snapshot(s.path()).unwrap().is_empty());
    }

    #[test]
    fn missing_folder_is_an_error() {
        let s = Scratch::new();
        assert!(snapshot(&s.path().join("nope")).is_err());
    }

    #[test]
    fn links_are_not_followed() {
        let s = Scratch::new();
        let outside = Scratch::new();
        outside.write("secret.txt", "outside");
        s.write("real.txt", "1");
        let link = s.path().join("link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.path(), &link);
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(outside.path(), &link);
        // Creating a symlink can need a privilege on Windows; without it there is
        // nothing to check.
        if made.is_err() {
            return;
        }
        // A link pointing back at the workspace must not make the walk loop.
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(s.path(), s.path().join("loop"));
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(s.path(), s.path().join("loop"));

        let snap = snapshot(s.path()).unwrap();
        assert!(snap.keys().all(|k| !k.starts_with("link/")));
        assert!(snap.keys().all(|k| !k.starts_with("loop/")));
        assert!(snap.contains_key("real.txt"));
    }

    #[test]
    fn subfolder_removed_after_it_was_listed_is_left_out() {
        let s = Scratch::new();
        s.write("keep.txt", "1");
        s.write("victim/inner.txt", "22");
        s.write("other/ok.txt", "333");
        let snap = walk(s.path(), &mut |dir| {
            if dir.file_name().is_some_and(|n| n == "victim") {
                fs::remove_dir_all(dir).unwrap();
            }
        })
        .unwrap();
        let keys: Vec<&str> = snap.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["keep.txt", "other/ok.txt"]);
    }

    #[test]
    fn subfolder_replaced_by_a_file_after_it_was_listed_is_left_out() {
        let s = Scratch::new();
        s.write("victim/inner.txt", "22");
        s.write("other/ok.txt", "333");
        let snap = walk(s.path(), &mut |dir| {
            if dir.file_name().is_some_and(|n| n == "victim") {
                fs::remove_dir_all(dir).unwrap();
                fs::write(dir, "now a file").unwrap();
            }
        })
        .unwrap();
        let keys: Vec<&str> = snap.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["other/ok.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subfolder_is_left_out_instead_of_failing() {
        use std::os::unix::fs::PermissionsExt;

        let s = Scratch::new();
        s.write("keep.txt", "1");
        s.write("locked/inner.txt", "22");
        s.write("locked/deeper/x.txt", "3");
        let locked = s.path().join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // Root (and anyone with CAP_DAC_OVERRIDE) can still list it: nothing to check.
        let can_list = fs::read_dir(&locked).is_ok();
        let result = snapshot(s.path());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        if can_list {
            return;
        }
        let snap = result.unwrap();
        let keys: Vec<&str> = snap.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["keep.txt"]);
    }

    #[test]
    fn snapshot_of_ten_thousand_files_is_fast() {
        let s = Scratch::new();
        for d in 0..100 {
            let dir = s.path().join(format!("d{d}"));
            fs::create_dir_all(&dir).unwrap();
            for f in 0..100 {
                fs::write(dir.join(format!("f{f}.txt")), "x").unwrap();
            }
        }
        let start = Instant::now();
        let snap = snapshot(s.path()).unwrap();
        let took = start.elapsed();
        assert_eq!(snap.len(), 10_000);
        assert!(took < Duration::from_secs(2), "snapshot took {took:?}");
        println!("snapshot of 10000 files took {took:?}");
    }
}
