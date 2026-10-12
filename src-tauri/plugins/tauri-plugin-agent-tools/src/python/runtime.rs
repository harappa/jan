//! The bundled Python runtime, copied once into the data folder.
//!
//! The installer ships the runtime read-only under `resources/python`. The
//! sandbox needs a stable folder it can mount, so the first run copies it to
//! `<data>/python-runtime/<RUNTIME_ID>`. A `.jan-complete` marker, written
//! just before the final rename, says the copy is whole.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// The bundled runtime's version: CPython version plus the python-build-standalone
/// release tag. `scripts/download-python.mjs` writes the same string to `jan-runtime-id`.
pub const RUNTIME_ID: &str = "3.15.0+20261009";

/// Written into a copy when it is whole; a folder without it is never used.
const COMPLETE_MARKER: &str = ".jan-complete";

/// File in the bundled folder that names the runtime it holds.
const ID_FILE: &str = "jan-runtime-id";

/// Where the runtime for this build lives: `<data>/python-runtime/<RUNTIME_ID>`.
pub fn runtime_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("python-runtime").join(RUNTIME_ID)
}

/// The interpreter inside a runtime folder.
pub fn python_executable(runtime: &Path) -> PathBuf {
    if cfg!(windows) {
        runtime.join("python").join("python.exe")
    } else {
        runtime.join("python").join("bin").join("python3")
    }
}

/// Make sure the runtime is in the data folder and return its folder.
///
/// `bundled` is the app's `resources/python`. A folder already marked complete is
/// returned as is. Otherwise the bundled tree is copied to a private
/// `<RUNTIME_ID>.partial-<pid>-<n>` folder, marked, and renamed into place, so an
/// interrupted copy (disk full, app killed) is never used and is redone next time.
///
/// Calls in one process are serialized, and each copy has its own partial folder,
/// so concurrent first runs (two chats, or two Jan instances) never share or
/// delete each other's files.
///
/// Synchronous file I/O: call it from a blocking task.
pub fn ensure_runtime(bundled: &Path, data_folder: &Path) -> Result<PathBuf, String> {
    ensure_runtime_with(
        bundled,
        data_folder,
        &Seams {
            after_dir: &|_| {},
            before_rename: &|| {},
        },
    )
}

/// Points where a test can act as another process while the copy runs.
struct Seams<'a> {
    /// Called with each subfolder of the partial right after it is created.
    after_dir: &'a dyn Fn(&Path),
    /// Called just before the finished copy is moved into place.
    before_rename: &'a dyn Fn(),
}

/// `ensure_runtime` with the test seams.
fn ensure_runtime_with(
    bundled: &Path,
    data_folder: &Path,
    seams: &Seams,
) -> Result<PathBuf, String> {
    let target = runtime_dir(data_folder);
    if target.join(COMPLETE_MARKER).is_file() {
        return Ok(target);
    }
    // A poisoned lock only means another copy panicked; its partial folder is
    // private and gets cleaned up below.
    let _guard = COPY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Another thread may have finished while this one waited.
    if target.join(COMPLETE_MARKER).is_file() {
        return Ok(target);
    }
    check_bundled(bundled)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| io_error("create", parent, &e))?;
    }
    // Leftovers of earlier runs that were killed mid-copy.
    remove_partials(&target)?;
    // A folder without the marker is a broken earlier copy: start over.
    remove_dir_if_exists(&target)?;

    let partial = unique_partial_dir(&target);
    let result = copy_and_publish(bundled, &partial, &target, seams);
    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result
}

fn copy_and_publish(
    bundled: &Path,
    partial: &Path,
    target: &Path,
    seams: &Seams,
) -> Result<PathBuf, String> {
    copy_tree(bundled, partial, seams.after_dir)?;
    let marker = partial.join(COMPLETE_MARKER);
    fs::write(&marker, RUNTIME_ID).map_err(|e| io_error("write", &marker, &e))?;
    (seams.before_rename)();
    if let Err(e) = fs::rename(partial, target) {
        // Another process may have finished the same copy first.
        if target.join(COMPLETE_MARKER).is_file() {
            let _ = fs::remove_dir_all(partial);
            return Ok(target.to_path_buf());
        }
        return Err(io_error("rename", partial, &e));
    }
    Ok(target.to_path_buf())
}

/// Serializes the copy section within this process.
static COPY_LOCK: Mutex<()> = Mutex::new(());

/// Distinguishes the partial folders of calls within one process.
static PARTIAL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A partial folder no other call or process uses.
fn unique_partial_dir(target: &Path) -> PathBuf {
    let n = PARTIAL_COUNTER.fetch_add(1, Ordering::SeqCst);
    let mut name = partial_dir(target).into_os_string();
    name.push(format!("-{}-{n}", std::process::id()));
    PathBuf::from(name)
}

/// Remove every `<RUNTIME_ID>.partial*` folder next to `target`.
fn remove_partials(target: &Path) -> Result<(), String> {
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return Ok(());
    };
    let prefix = format!("{}.partial", name.to_string_lossy());
    let entries = fs::read_dir(parent).map_err(|e| io_error("read", parent, &e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_error("read", parent, &e))?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            remove_dir_if_exists(&entry.path())?;
        }
    }
    Ok(())
}

/// The bundled folder must hold this build's runtime. In builds where it was not
/// fetched (CI, `make dev`) it holds only a stub file.
fn check_bundled(bundled: &Path) -> Result<(), String> {
    let id_path = bundled.join(ID_FILE);
    let id = match fs::read_to_string(&id_path) {
        Ok(id) => id,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "the Python runtime is not bundled in this build ({} not found)",
                id_path.display()
            ));
        }
        Err(e) => return Err(io_error("read", &id_path, &e)),
    };
    let id = id.trim();
    if id != RUNTIME_ID {
        return Err(format!(
            "the bundled Python runtime is {id}, but this build expects {RUNTIME_ID}"
        ));
    }
    let exe = python_executable(bundled);
    if !exe.is_file() {
        return Err(format!(
            "the bundled Python runtime is incomplete ({} not found)",
            exe.display()
        ));
    }
    Ok(())
}

fn remove_dir_if_exists(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error("remove", dir, &e)),
    }
}

/// Copy `src` into `dst` (created). Symlinks are never followed: on Unix they are
/// recreated as links (the runtime's `python3 -> python3.15` needs that); on
/// Windows, where creating one may need a privilege and the runtime has none, they
/// are left out.
///
/// Only `dst` itself is created with `create_dir_all`; subfolders use `create_dir`,
/// so if something removes the partial mid-copy (another Jan instance cleaning up
/// leftovers) the copy fails instead of silently recreating a half-empty folder.
fn copy_tree(src: &Path, dst: &Path, after_dir: &dyn Fn(&Path)) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| io_error("create", dst, &e))?;
    copy_children(src, dst, after_dir)
}

fn copy_children(src: &Path, dst: &Path, after_dir: &dyn Fn(&Path)) -> Result<(), String> {
    let entries = fs::read_dir(src).map_err(|e| io_error("read", src, &e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_error("read", src, &e))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        // `DirEntry::file_type` does not follow symlinks.
        let file_type = entry.file_type().map_err(|e| io_error("stat", &from, &e))?;
        if file_type.is_symlink() {
            copy_symlink(&from, &to)?;
        } else if file_type.is_dir() {
            fs::create_dir(&to).map_err(|e| io_error("create", &to, &e))?;
            after_dir(&to);
            copy_children(&from, &to, after_dir)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to).map_err(|e| io_error("copy", &from, &e))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> Result<(), String> {
    let target = fs::read_link(from).map_err(|e| io_error("read link", from, &e))?;
    std::os::unix::fs::symlink(&target, to).map_err(|e| io_error("link", to, &e))
}

#[cfg(not(unix))]
fn copy_symlink(_from: &Path, _to: &Path) -> Result<(), String> {
    Ok(())
}

fn io_error(action: &str, path: &Path, e: &std::io::Error) -> String {
    format!("could not {action} {}: {e}", path.display())
}

/// `<RUNTIME_ID>` -> `<RUNTIME_ID>.partial`, next to it.
fn partial_dir(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    target.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A scratch directory under the host temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir =
                std::env::temp_dir().join(format!("jan_runtime_test_{}_{}", std::process::id(), n));
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

    /// A fake `resources/python` holding a runtime with the given id file content.
    fn fake_bundled(id_file: &str) -> Scratch {
        let bundled = Scratch::new();
        bundled.write(ID_FILE, id_file);
        let exe = python_executable(Path::new(""));
        bundled.write(exe.to_str().unwrap(), "interpreter");
        bundled.write("python/Lib/os.py", "# os");
        bundled.write("python/Lib/site-packages/pkg/__init__.py", "# pkg");
        bundled
    }

    /// Every file under `root`, relative to it.
    fn files_under(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path.strip_prefix(root).unwrap().to_path_buf());
                }
            }
        }
        out
    }

    #[test]
    fn runtime_dir_is_versioned_under_the_data_folder() {
        let dir = runtime_dir(Path::new("data"));
        assert_eq!(
            dir,
            Path::new("data").join("python-runtime").join(RUNTIME_ID)
        );
    }

    #[test]
    fn python_executable_is_inside_the_python_folder() {
        let exe = python_executable(Path::new("rt"));
        if cfg!(windows) {
            assert_eq!(exe, Path::new("rt").join("python").join("python.exe"));
        } else {
            assert_eq!(
                exe,
                Path::new("rt").join("python").join("bin").join("python3")
            );
        }
    }

    #[test]
    fn copies_the_bundle_and_marks_it_complete() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let dir = ensure_runtime(bundled.path(), data.path()).unwrap();
        assert_eq!(dir, runtime_dir(data.path()));
        assert!(dir.join(COMPLETE_MARKER).is_file());
        assert_eq!(
            fs::read_to_string(dir.join("python/Lib/site-packages/pkg/__init__.py")).unwrap(),
            "# pkg"
        );
        assert_eq!(
            fs::read_to_string(python_executable(&dir)).unwrap(),
            "interpreter"
        );
        assert!(!partial_dir(&dir).exists());
    }

    #[test]
    fn accepts_an_id_file_with_a_trailing_newline() {
        let bundled = fake_bundled(&format!("{RUNTIME_ID}\r\n"));
        let data = Scratch::new();
        assert!(ensure_runtime(bundled.path(), data.path()).is_ok());
    }

    #[test]
    fn a_complete_copy_is_not_copied_again() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let dir = ensure_runtime(bundled.path(), data.path()).unwrap();
        // Pin the marker's time far in the past and add a file the bundle lacks.
        let past = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let marker = fs::OpenOptions::new()
            .write(true)
            .open(dir.join(COMPLETE_MARKER))
            .unwrap();
        marker.set_modified(past).unwrap();
        drop(marker);
        fs::write(dir.join("extra.txt"), "kept").unwrap();

        // Once complete, the bundle is not even looked at.
        let again = ensure_runtime(&data.path().join("no-such-bundle"), data.path()).unwrap();
        assert_eq!(again, dir);
        let modified = fs::metadata(dir.join(COMPLETE_MARKER))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(modified, past);
        assert_eq!(fs::read_to_string(dir.join("extra.txt")).unwrap(), "kept");
    }

    #[test]
    fn a_leftover_partial_copy_is_redone() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let partial = partial_dir(&runtime_dir(data.path()));
        fs::create_dir_all(partial.join("python")).unwrap();
        fs::write(partial.join("python/half-written.bin"), "junk").unwrap();

        let dir = ensure_runtime(bundled.path(), data.path()).unwrap();
        assert!(dir.join(COMPLETE_MARKER).is_file());
        assert!(dir.join("python/Lib/os.py").is_file());
        assert!(!dir.join("python/half-written.bin").exists());
        assert!(!partial.exists());
    }

    #[test]
    fn a_final_folder_without_the_marker_is_redone() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let broken = runtime_dir(data.path());
        fs::create_dir_all(broken.join("python")).unwrap();
        fs::write(broken.join("python/stale.bin"), "junk").unwrap();

        let dir = ensure_runtime(bundled.path(), data.path()).unwrap();
        assert!(dir.join(COMPLETE_MARKER).is_file());
        assert!(dir.join("python/Lib/os.py").is_file());
        assert!(!dir.join("python/stale.bin").exists());
    }

    #[test]
    fn leftover_partials_of_any_name_are_removed() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let target = runtime_dir(data.path());
        let parent = target.parent().unwrap();
        let old = parent.join(format!("{RUNTIME_ID}.partial-99999-0"));
        fs::create_dir_all(old.join("python")).unwrap();
        fs::write(old.join("python/half.bin"), "junk").unwrap();
        let other = parent.join("unrelated");
        fs::create_dir_all(&other).unwrap();

        ensure_runtime(bundled.path(), data.path()).unwrap();
        assert!(!old.exists());
        assert!(other.exists());
        assert!(target.join(COMPLETE_MARKER).is_file());
    }

    #[test]
    fn concurrent_first_calls_all_get_a_whole_runtime() {
        let bundled = fake_bundled(RUNTIME_ID);
        // Enough files that the copies overlap in time.
        for i in 0..300 {
            bundled.write(&format!("python/Lib/mod{}/file{i}.py", i % 20), "# x");
        }
        let data = Scratch::new();
        let results: Vec<Result<PathBuf, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..6)
                .map(|_| scope.spawn(|| ensure_runtime(bundled.path(), data.path())))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let expected = runtime_dir(data.path());
        for result in &results {
            assert_eq!(result.as_ref().unwrap(), &expected);
        }
        assert!(expected.join(COMPLETE_MARKER).is_file());
        for rel in files_under(bundled.path()) {
            assert!(expected.join(&rel).is_file(), "missing {}", rel.display());
        }
        let leftovers: Vec<_> = fs::read_dir(expected.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers.len(), 1, "{leftovers:?}");
    }

    #[test]
    fn a_target_completed_by_someone_else_before_the_rename_is_used() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let target = runtime_dir(data.path());
        let finish_elsewhere = || {
            fs::create_dir_all(target.join("python")).unwrap();
            fs::write(target.join("python/from-other.txt"), "other").unwrap();
            fs::write(target.join(COMPLETE_MARKER), RUNTIME_ID).unwrap();
        };
        let dir = ensure_runtime_with(
            bundled.path(),
            data.path(),
            &Seams {
                after_dir: &|_| {},
                before_rename: &finish_elsewhere,
            },
        )
        .unwrap();
        assert_eq!(dir, target);
        // The other copy is kept untouched and our own partial is gone.
        assert!(target.join("python/from-other.txt").is_file());
        assert!(!target.join("python/Lib/os.py").exists());
        let names: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn a_rename_that_fails_without_a_complete_target_is_an_error() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        let target = runtime_dir(data.path());
        // A non-empty target without the marker blocks the rename.
        let block = || {
            fs::create_dir_all(target.join("python")).unwrap();
            fs::write(target.join("python/junk.bin"), "junk").unwrap();
        };
        assert!(ensure_runtime_with(
            bundled.path(),
            data.path(),
            &Seams {
                after_dir: &|_| {},
                before_rename: &block,
            },
        )
        .is_err());
        assert!(!target.join(COMPLETE_MARKER).exists());
        // Our partial is cleaned up on failure.
        let names: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn a_partial_removed_mid_copy_fails_instead_of_publishing_a_gap() {
        let bundled = fake_bundled(RUNTIME_ID);
        bundled.write("python/Lib/a/x.py", "# a");
        bundled.write("python/Lib/b/y.py", "# b");
        bundled.write("python/DLLs/z.pyd", "# z");
        let data = Scratch::new();
        let target = runtime_dir(data.path());
        let parent = target.parent().unwrap().to_path_buf();
        // Another process cleaning up leftovers deletes this call's partial once.
        let removed = std::cell::Cell::new(false);
        let remove_partials_elsewhere = |_: &Path| {
            if !removed.replace(true) {
                for entry in fs::read_dir(&parent).unwrap() {
                    let path = entry.unwrap().path();
                    if path.to_string_lossy().contains(".partial") {
                        fs::remove_dir_all(path).unwrap();
                    }
                }
            }
        };
        let result = ensure_runtime_with(
            bundled.path(),
            data.path(),
            &Seams {
                after_dir: &remove_partials_elsewhere,
                before_rename: &|| {},
            },
        );
        assert!(removed.get());
        assert!(result.is_err(), "{result:?}");
        assert!(!target.exists());
        // The next call starts over and succeeds with every file present.
        let dir = ensure_runtime(bundled.path(), data.path()).unwrap();
        for rel in files_under(bundled.path()) {
            assert!(dir.join(&rel).is_file(), "missing {}", rel.display());
        }
    }

    #[test]
    fn a_failed_copy_leaves_no_complete_runtime() {
        let bundled = fake_bundled(RUNTIME_ID);
        let data = Scratch::new();
        // A file where the runtime's parent folder should be makes the copy fail.
        data.write("python-runtime", "not a folder");
        assert!(ensure_runtime(bundled.path(), data.path()).is_err());
        assert!(!runtime_dir(data.path()).join(COMPLETE_MARKER).exists());
    }

    #[test]
    fn a_bundle_of_another_version_is_an_error() {
        let bundled = fake_bundled("3.14.0+20250101");
        let data = Scratch::new();
        let err = ensure_runtime(bundled.path(), data.path()).unwrap_err();
        assert!(err.contains("3.14.0+20250101"), "{err}");
        assert!(err.contains(RUNTIME_ID), "{err}");
        assert!(!runtime_dir(data.path()).exists());
    }

    #[test]
    fn a_stub_bundle_is_reported_as_not_bundled() {
        let bundled = Scratch::new();
        bundled.write(".stub", "");
        let data = Scratch::new();
        let err = ensure_runtime(bundled.path(), data.path()).unwrap_err();
        assert!(err.contains("not bundled"), "{err}");
        assert!(!data.path().join("python-runtime").exists());
    }

    #[test]
    fn a_missing_bundle_folder_is_reported_as_not_bundled() {
        let data = Scratch::new();
        let err = ensure_runtime(&data.path().join("nope"), data.path()).unwrap_err();
        assert!(err.contains("not bundled"), "{err}");
    }

    #[test]
    fn a_bundle_without_an_interpreter_is_an_error() {
        let bundled = Scratch::new();
        bundled.write(ID_FILE, RUNTIME_ID);
        bundled.write("python/Lib/os.py", "# os");
        let data = Scratch::new();
        let err = ensure_runtime(bundled.path(), data.path()).unwrap_err();
        assert!(err.contains("incomplete"), "{err}");
        assert!(!runtime_dir(data.path()).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_recreated_not_followed() {
        let bundled = fake_bundled(RUNTIME_ID);
        let outside = Scratch::new();
        outside.write("secret.txt", "outside");
        std::os::unix::fs::symlink(outside.path(), bundled.path().join("python/escape")).unwrap();
        std::os::unix::fs::symlink("os.py", bundled.path().join("python/Lib/alias.py")).unwrap();

        let data = Scratch::new();
        let dir = ensure_runtime(bundled.path(), data.path()).unwrap();
        let escape = dir.join("python/escape");
        assert!(fs::symlink_metadata(&escape)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&escape).unwrap(), outside.path());
        let alias = dir.join("python/Lib/alias.py");
        assert_eq!(fs::read_link(&alias).unwrap(), Path::new("os.py"));
    }
}
