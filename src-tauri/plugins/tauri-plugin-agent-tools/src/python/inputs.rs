//! Staging a thread's attachments as read-only inputs for the python tool.

use serde::Deserialize;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use super::names::safe_file_name;
use crate::workspace::{permanent_store, thread_segment};

/// Folder under the agent workspace that holds every thread's inputs.
const INPUTS: &str = "inputs";

/// One file the user attached to the conversation: either a file on disk
/// (`path`) or text the app already holds (`content`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub path: Option<String>,
    pub content: Option<String>,
}

/// The largest attachment that is staged.
pub const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;

/// What a staging pass did.
#[derive(Debug, Default)]
pub struct StageReport {
    /// File names now present in the inputs directory, in attachment order.
    pub staged: Vec<String>,
    /// `(attachment name, reason)` for each attachment that was not staged.
    pub skipped: Vec<(String, String)>,
}

/// `<data_folder>/agent-workspace/inputs/<thread segment>`.
pub fn inputs_dir(data_folder: &Path, thread_id: &str) -> Result<PathBuf, String> {
    Ok(permanent_store(data_folder)
        .join(INPUTS)
        .join(thread_segment(thread_id)?))
}

const NOT_READABLE: &str = "not a readable file";

/// Where an attachment's bytes come from, once it has passed the checks.
enum Source<'a> {
    File {
        path: PathBuf,
        len: u64,
        modified: Option<SystemTime>,
    },
    Text(&'a str),
}

/// An attachment that will be staged, under the name it will have.
struct Planned<'a> {
    /// The attachment's own name, for the report.
    attachment: &'a str,
    name: String,
    source: Source<'a>,
}

/// Make `dir` hold exactly the given attachments, under safe unique names.
///
/// A file whose size and modification time already match its staged copy is
/// left alone, so a thread's inputs are not copied again on every run. Anything
/// else in `dir` (attachments since removed, leftovers of an interrupted copy)
/// is deleted. Files go in under a temporary name and are renamed into place,
/// so an interrupted copy never leaves a half-written input behind.
pub fn stage_inputs(dir: &Path, attachments: &[Attachment]) -> Result<StageReport, String> {
    let mut report = StageReport::default();
    let planned = plan(attachments, &mut report);

    fs::create_dir_all(dir)
        .map_err(|e| format!("cannot create the inputs folder {}: {e}", dir.display()))?;
    let keep: HashSet<&str> = planned.iter().map(|p| p.name.as_str()).collect();
    remove_stale(dir, &keep)?;

    for item in planned {
        let dest = dir.join(&item.name);
        let staged = match &item.source {
            Source::File {
                path,
                len,
                modified,
            } => copy_file(dir, &dest, path, *len, *modified)?,
            Source::Text(text) => {
                write_text(dir, &dest, text)?;
                true
            }
        };
        if staged {
            report.staged.push(item.name);
        } else {
            // The source vanished after it was checked: drop any older copy.
            remove_if_exists(&dest)?;
            report
                .skipped
                .push((item.attachment.to_string(), NOT_READABLE.to_string()));
        }
    }
    Ok(report)
}

/// Check each attachment and give the usable ones their final names. Rejected
/// ones go to `report.skipped` and do not use up a name.
fn plan<'a>(attachments: &'a [Attachment], report: &mut StageReport) -> Vec<Planned<'a>> {
    let mut used: HashSet<String> = HashSet::new();
    let mut planned = Vec::new();
    for attachment in attachments {
        let mut skip = |reason: &str| {
            report
                .skipped
                .push((attachment.name.clone(), reason.to_string()));
        };
        let Some(base) = safe_file_name(&attachment.name) else {
            skip("invalid file name");
            continue;
        };
        let (base, source) = if let Some(path) = &attachment.path {
            match fs::metadata(path) {
                Ok(meta) if meta.is_file() => {
                    if meta.len() > MAX_INPUT_BYTES {
                        skip(TOO_LARGE);
                        continue;
                    }
                    let source = Source::File {
                        path: PathBuf::from(path),
                        len: meta.len(),
                        modified: meta.modified().ok(),
                    };
                    (base, source)
                }
                _ => {
                    skip(NOT_READABLE);
                    continue;
                }
            }
        } else if let Some(text) = &attachment.content {
            if text.len() as u64 > MAX_INPUT_BYTES {
                skip(TOO_LARGE);
                continue;
            }
            let base = if base.to_ascii_lowercase().ends_with(".txt") {
                base
            } else {
                format!("{base}.txt")
            };
            (base, Source::Text(text))
        } else {
            skip(NOT_READABLE);
            continue;
        };
        let name = unique_name(&base, &mut used);
        planned.push(Planned {
            attachment: &attachment.name,
            name,
            source,
        });
    }
    planned
}

const TOO_LARGE: &str = "larger than 256 MB";

/// `name`, or `stem (n).ext` for the first `n >= 2` that is free. Names are
/// compared without regard to case: Windows and macOS would treat two
/// spellings as one file.
fn unique_name(name: &str, used: &mut HashSet<String>) -> String {
    if used.insert(name.to_lowercase()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    (2..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| used.insert(candidate.to_lowercase()))
        .expect("an unbounded range always yields a free name")
}

/// Delete everything in `dir` that is not a regular file named in `keep`.
fn remove_stale(dir: &Path, keep: &HashSet<&str>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("cannot list the inputs folder {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot inspect {}: {e}", entry.path().display()))?;
        let wanted =
            file_type.is_file() && keep.contains(entry.file_name().to_string_lossy().as_ref());
        if wanted {
            continue;
        }
        let path = entry.path();
        let removed = if file_type.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        removed.map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
    }
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A name for the file being written, in `dir` so the rename stays on one
/// volume. Unique per process and call, so two passes never share one.
fn temp_path(dir: &Path) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".stage-{}-{n}.tmp", std::process::id()))
}

fn rename_into_place(temp: &Path, dest: &Path) -> Result<(), String> {
    fs::rename(temp, dest).map_err(|e| {
        let _ = fs::remove_file(temp);
        format!("cannot stage {}: {e}", dest.display())
    })
}

/// Copy `source` to `dest` unless `dest` already matches it. `Ok(false)` when
/// the source cannot be opened any more.
fn copy_file(
    dir: &Path,
    dest: &Path,
    source: &Path,
    len: u64,
    modified: Option<SystemTime>,
) -> Result<bool, String> {
    if let (Ok(existing), Some(modified)) = (fs::metadata(dest), modified) {
        if existing.is_file() && existing.len() == len && existing.modified().ok() == Some(modified)
        {
            return Ok(true);
        }
    }
    let Ok(mut reader) = fs::File::open(source) else {
        return Ok(false);
    };
    let temp = temp_path(dir);
    // Copy through handles rather than `fs::copy`, which would carry the
    // source's read-only flag over and make the staged file hard to replace.
    let written = fs::File::create(&temp)
        .and_then(|mut writer| {
            io::copy(&mut reader, &mut writer)?;
            if let Some(modified) = modified {
                writer.set_modified(modified)?;
            }
            Ok(())
        })
        .map_err(|e| {
            let _ = fs::remove_file(&temp);
            format!(
                "cannot copy {} to {}: {e}",
                source.display(),
                dest.display()
            )
        });
    written?;
    rename_into_place(&temp, dest)?;
    Ok(true)
}

/// Write `text` to `dest` unless it already holds exactly that.
fn write_text(dir: &Path, dest: &Path, text: &str) -> Result<(), String> {
    if fs::read(dest).is_ok_and(|existing| existing == text.as_bytes()) {
        return Ok(());
    }
    let temp = temp_path(dir);
    fs::write(&temp, text).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("cannot write {}: {e}", dest.display())
    })?;
    rename_into_place(&temp, dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A scratch directory under the host temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir =
                std::env::temp_dir().join(format!("jan_inputs_test_{}_{}", std::process::id(), n));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// A new file under `src/` with the given content.
        fn source(&self, name: &str, content: &str) -> PathBuf {
            let dir = self.0.join("src");
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join(name);
            fs::write(&path, content).unwrap();
            path
        }

        /// The (not yet created) inputs directory.
        fn dest(&self) -> PathBuf {
            self.0.join("inputs")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn from_path(name: &str, path: &Path) -> Attachment {
        Attachment {
            name: name.to_string(),
            path: Some(path.to_string_lossy().into_owned()),
            content: None,
        }
    }

    fn from_content(name: &str, content: &str) -> Attachment {
        Attachment {
            name: name.to_string(),
            path: None,
            content: Some(content.to_string()),
        }
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn set_mtime(path: &Path, time: SystemTime) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    #[test]
    fn inputs_dir_is_under_agent_workspace_inputs() {
        let dir = inputs_dir(Path::new("/data"), "abc-123").unwrap();
        assert_eq!(dir, Path::new("/data/agent-workspace/inputs/abc-123"));
    }

    #[test]
    fn inputs_dir_rejects_ids_that_could_escape() {
        for bad in ["", "..", "a/b", "a\\b", "../x"] {
            assert!(inputs_dir(Path::new("/data"), bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn stages_files_by_path_under_the_same_name() {
        let s = Scratch::new();
        let a = s.source("a.csv", "1,2\n");
        let b = s.source("b.txt", "hello");
        let dest = s.dest();
        let report =
            stage_inputs(&dest, &[from_path("a.csv", &a), from_path("b.txt", &b)]).unwrap();
        assert_eq!(report.staged, vec!["a.csv", "b.txt"]);
        assert!(report.skipped.is_empty());
        assert_eq!(fs::read_to_string(dest.join("a.csv")).unwrap(), "1,2\n");
        assert_eq!(fs::read_to_string(dest.join("b.txt")).unwrap(), "hello");
        assert_eq!(names_in(&dest), vec!["a.csv", "b.txt"]);
    }

    #[test]
    fn unsafe_names_become_safe_and_stay_inside_the_directory() {
        let s = Scratch::new();
        let a = s.source("a", "x");
        let dest = s.dest();
        let report = stage_inputs(
            &dest,
            &[
                from_path("C:\\x\\レポート.pdf", &a),
                from_path("../../evil?.txt", &a),
            ],
        )
        .unwrap();
        assert_eq!(report.staged, vec!["レポート.pdf", "evil_.txt"]);
        assert_eq!(names_in(&dest), vec!["evil_.txt", "レポート.pdf"]);
        assert!(!s.path().join("evil_.txt").exists());
    }

    #[test]
    fn a_name_with_nothing_usable_is_skipped() {
        let s = Scratch::new();
        let a = s.source("a", "x");
        let dest = s.dest();
        let report = stage_inputs(&dest, &[from_path("..", &a)]).unwrap();
        assert!(report.staged.is_empty());
        assert_eq!(
            report.skipped,
            vec![("..".to_string(), "invalid file name".to_string())]
        );
    }

    #[test]
    fn duplicate_names_get_a_number() {
        let s = Scratch::new();
        let a = s.source("1.csv", "one");
        let b = s.source("2.csv", "two");
        let c = s.source("3.csv", "three");
        let dest = s.dest();
        let report = stage_inputs(
            &dest,
            &[
                from_path("data.csv", &a),
                from_path("data.csv", &b),
                from_path("DATA.csv", &c),
            ],
        )
        .unwrap();
        assert_eq!(
            report.staged,
            vec!["data.csv", "data (2).csv", "DATA (3).csv"]
        );
        assert_eq!(fs::read_to_string(dest.join("data.csv")).unwrap(), "one");
        assert_eq!(
            fs::read_to_string(dest.join("data (2).csv")).unwrap(),
            "two"
        );
        assert_eq!(
            fs::read_to_string(dest.join("DATA (3).csv")).unwrap(),
            "three"
        );
    }

    #[test]
    fn content_attachments_are_written_as_txt() {
        let s = Scratch::new();
        let dest = s.dest();
        let report = stage_inputs(
            &dest,
            &[
                from_content("notes", "alpha"),
                from_content("log.txt", "beta"),
                from_content("big.csv", "gamma"),
            ],
        )
        .unwrap();
        assert_eq!(report.staged, vec!["notes.txt", "log.txt", "big.csv.txt"]);
        assert_eq!(fs::read_to_string(dest.join("notes.txt")).unwrap(), "alpha");
        assert_eq!(fs::read_to_string(dest.join("log.txt")).unwrap(), "beta");
        assert_eq!(
            fs::read_to_string(dest.join("big.csv.txt")).unwrap(),
            "gamma"
        );
    }

    #[test]
    fn an_unchanged_file_is_not_copied_again() {
        let s = Scratch::new();
        let a = s.source("a.csv", "AAAA");
        let dest = s.dest();
        let atts = [from_path("a.csv", &a)];
        stage_inputs(&dest, &atts).unwrap();

        // Change the staged copy to different bytes of the same size and
        // restore its time: a second pass that copied again would undo this.
        let staged = dest.join("a.csv");
        let mtime = fs::metadata(&staged).unwrap().modified().unwrap();
        fs::write(&staged, "BBBB").unwrap();
        set_mtime(&staged, mtime);

        let report = stage_inputs(&dest, &atts).unwrap();
        assert_eq!(report.staged, vec!["a.csv"]);
        assert_eq!(fs::read_to_string(&staged).unwrap(), "BBBB");
        assert_eq!(fs::metadata(&staged).unwrap().modified().unwrap(), mtime);
    }

    #[test]
    fn a_changed_source_is_copied_again() {
        let s = Scratch::new();
        let a = s.source("a.csv", "AAAA");
        let dest = s.dest();
        let atts = [from_path("a.csv", &a)];
        stage_inputs(&dest, &atts).unwrap();

        fs::write(&a, "CCCCCC").unwrap();
        set_mtime(&a, SystemTime::now() + Duration::from_secs(60));

        stage_inputs(&dest, &atts).unwrap();
        assert_eq!(fs::read_to_string(dest.join("a.csv")).unwrap(), "CCCCCC");
    }

    #[test]
    fn files_no_longer_attached_are_removed() {
        let s = Scratch::new();
        let a = s.source("a.csv", "a");
        let b = s.source("b.csv", "b");
        let dest = s.dest();
        stage_inputs(&dest, &[from_path("a.csv", &a), from_path("b.csv", &b)]).unwrap();
        // A stray folder and a leftover temp file go too.
        fs::create_dir_all(dest.join("old-dir")).unwrap();
        fs::write(dest.join("old-dir").join("x"), "x").unwrap();
        fs::write(dest.join(".leftover.tmp"), "x").unwrap();

        let report = stage_inputs(&dest, &[from_path("b.csv", &b)]).unwrap();
        assert_eq!(report.staged, vec!["b.csv"]);
        assert_eq!(names_in(&dest), vec!["b.csv"]);
    }

    #[test]
    fn detaching_everything_empties_the_directory() {
        let s = Scratch::new();
        let a = s.source("a.csv", "a");
        let dest = s.dest();
        stage_inputs(&dest, &[from_path("a.csv", &a)]).unwrap();
        let report = stage_inputs(&dest, &[]).unwrap();
        assert!(report.staged.is_empty());
        assert!(names_in(&dest).is_empty());
    }

    #[test]
    fn a_file_over_the_limit_is_skipped() {
        let s = Scratch::new();
        let big = s.source("big.bin", "");
        fs::File::options()
            .write(true)
            .open(&big)
            .unwrap()
            .set_len(MAX_INPUT_BYTES + 1)
            .unwrap();
        let small = s.source("small.txt", "ok");
        let dest = s.dest();
        let report = stage_inputs(
            &dest,
            &[from_path("big.bin", &big), from_path("small.txt", &small)],
        )
        .unwrap();
        assert_eq!(report.staged, vec!["small.txt"]);
        assert_eq!(
            report.skipped,
            vec![("big.bin".to_string(), "larger than 256 MB".to_string())]
        );
        assert_eq!(names_in(&dest), vec!["small.txt"]);
    }

    #[test]
    fn a_file_of_exactly_the_limit_is_staged() {
        let s = Scratch::new();
        let exact = s.source("exact.bin", "");
        fs::File::options()
            .write(true)
            .open(&exact)
            .unwrap()
            .set_len(MAX_INPUT_BYTES)
            .unwrap();
        let dest = s.dest();
        let report = stage_inputs(&dest, &[from_path("exact.bin", &exact)]).unwrap();
        assert_eq!(report.staged, vec!["exact.bin"]);
        assert_eq!(
            fs::metadata(dest.join("exact.bin")).unwrap().len(),
            MAX_INPUT_BYTES
        );
    }

    #[test]
    fn a_folder_or_a_missing_path_is_skipped() {
        let s = Scratch::new();
        let folder = s.path().join("src");
        fs::create_dir_all(&folder).unwrap();
        let missing = s.path().join("nope.txt");
        let dest = s.dest();
        let report = stage_inputs(
            &dest,
            &[from_path("dir", &folder), from_path("nope.txt", &missing)],
        )
        .unwrap();
        assert!(report.staged.is_empty());
        let reason = "not a readable file".to_string();
        assert_eq!(
            report.skipped,
            vec![
                ("dir".to_string(), reason.clone()),
                ("nope.txt".to_string(), reason)
            ]
        );
    }

    #[test]
    fn an_attachment_with_neither_path_nor_content_is_skipped() {
        let s = Scratch::new();
        let dest = s.dest();
        let empty = Attachment {
            name: "x.txt".to_string(),
            path: None,
            content: None,
        };
        let report = stage_inputs(&dest, &[empty]).unwrap();
        assert_eq!(
            report.skipped,
            vec![("x.txt".to_string(), "not a readable file".to_string())]
        );
    }

    #[test]
    fn a_skipped_attachment_does_not_use_up_a_name() {
        let s = Scratch::new();
        let missing = s.path().join("nope.csv");
        let ok = s.source("ok.csv", "ok");
        let dest = s.dest();
        let report = stage_inputs(
            &dest,
            &[from_path("data.csv", &missing), from_path("data.csv", &ok)],
        )
        .unwrap();
        assert_eq!(report.staged, vec!["data.csv"]);
    }

    #[test]
    fn a_folder_in_the_way_of_a_name_is_replaced() {
        let s = Scratch::new();
        let a = s.source("a.csv", "a");
        let dest = s.dest();
        fs::create_dir_all(dest.join("a.csv")).unwrap();
        let report = stage_inputs(&dest, &[from_path("a.csv", &a)]).unwrap();
        assert_eq!(report.staged, vec!["a.csv"]);
        assert_eq!(fs::read_to_string(dest.join("a.csv")).unwrap(), "a");
    }

    #[test]
    fn attachment_deserializes_from_camel_case_json() {
        let a: Attachment =
            serde_json::from_str(r#"{"name":"a.csv","path":"/tmp/a.csv"}"#).unwrap();
        assert_eq!(a.name, "a.csv");
        assert_eq!(a.path.as_deref(), Some("/tmp/a.csv"));
        assert!(a.content.is_none());
    }
}
