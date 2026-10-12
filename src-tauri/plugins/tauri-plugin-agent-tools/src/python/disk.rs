//! How much disk a python run uses: the workspace's growth (the 1 GiB limit)
//! and the drop in the volume's free space (the 2 GiB backstop).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use super::snapshot::{snapshot, total_size};

/// A run is stopped once the workspace has grown by more than this since it started.
pub const DISK_LIMIT_BYTES: u64 = 1 << 30;
/// A run is stopped once the free space of the workspace's volume has dropped
/// by more than this since it started. Catches writes the folder walk cannot
/// see: files deleted while still open, folders made unreadable, and Windows
/// alternate data streams.
pub const VOLUME_LIMIT_BYTES: u64 = 2 * DISK_LIMIT_BYTES;
/// How often the free space is read while a run is going.
pub const POLL_MS: u64 = 500;
/// The shortest gap between two workspace walks. Small: a script can put 2 GB
/// into the page cache in well under a second.
pub const WALK_FLOOR: Duration = Duration::from_millis(20);

/// Why the disk watch wants a run stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskStop {
    /// The workspace grew by more than `DISK_LIMIT_BYTES`.
    Folder,
    /// The volume lost more than `VOLUME_LIMIT_BYTES` of free space.
    Volume,
}

/// Whether to stop, from the free space when the run started and now (`None`
/// when it could not be read) and the workspace's latest measured growth. The
/// folder limit is checked first: it is the one the model is told about.
pub fn disk_stop(
    start_free: Option<u64>,
    now_free: Option<u64>,
    folder_growth: u64,
) -> Option<DiskStop> {
    if folder_growth > DISK_LIMIT_BYTES {
        return Some(DiskStop::Folder);
    }
    match (start_free, now_free) {
        (Some(start), Some(now)) if start.saturating_sub(now) > VOLUME_LIMIT_BYTES => {
            Some(DiskStop::Volume)
        }
        _ => None,
    }
}

/// The pause before the next workspace walk, given how long the last one took:
/// at least `WALK_FLOOR`, and twice the walk, so walking takes at most a third
/// of one core however large the workspace is.
pub fn walk_gap(walk: Duration) -> Duration {
    (walk * 2).max(WALK_FLOOR)
}

/// How many bytes the workspace has grown by since it held `before_size`.
///
/// Unreadable parts of the folder are skipped, and an unreadable root counts as
/// no growth: the check must not stop a run by mistake.
///
/// On Windows a folder listing gives each file's size as its directory entry
/// last recorded it, and NTFS updates that for a file open for writing only
/// when it is closed: a script writing 2 GiB through one handle was listed at
/// 0 bytes throughout. So there each file's size is read from the file itself
/// (`symlink_metadata` opens it without following links). Unix listings are
/// already exact.
pub fn grown_since(workspace: &Path, before_size: u64) -> u64 {
    let Ok(listed) = snapshot(workspace) else {
        return 0;
    };
    let now = if cfg!(windows) {
        listed
            .iter()
            .map(|(rel, (size, _))| {
                std::fs::symlink_metadata(workspace.join(rel)).map_or(*size, |m| m.len())
            })
            .sum()
    } else {
        total_size(&listed)
    };
    now.saturating_sub(before_size)
}

/// The bytes free (to this user) on the volume holding `path`, or `None` when
/// it cannot be read.
#[cfg(windows)]
pub fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the two totals
    // are optional and passed as null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

/// The bytes free (to unprivileged users) on the volume holding `path`, or
/// `None` when it cannot be read.
#[cfg(unix)]
// The field types differ by platform (`u32` or `u64`), so the casts are only
// redundant on some of them.
#[allow(clippy::unnecessary_cast)]
pub fn free_space(path: &Path) -> Option<u64> {
    use nix::libc;
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated; `stat` is written by a successful call.
    let stat = unsafe {
        if libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) != 0 {
            return None;
        }
        stat.assume_init()
    };
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

/// The workspace walked on its own thread, so a large workspace never holds up
/// the poll that enforces the deadline, the stops and cancelling. The thread
/// ends after its current walk once this is dropped.
pub struct FolderWatch {
    growth: Arc<AtomicU64>,
    _stop: mpsc::Sender<()>,
}

impl FolderWatch {
    /// Start walking `workspace` at once, then every `walk_gap`.
    pub fn start(workspace: PathBuf, before_size: u64) -> Self {
        let growth = Arc::new(AtomicU64::new(0));
        let (stop, stopped) = mpsc::channel::<()>();
        let published = Arc::clone(&growth);
        std::thread::spawn(move || loop {
            let started = Instant::now();
            published.store(grown_since(&workspace, before_size), Ordering::Relaxed);
            match stopped.recv_timeout(walk_gap(started.elapsed())) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => return,
            }
        });
        FolderWatch {
            growth,
            _stop: stop,
        }
    }

    /// The growth the latest finished walk measured (0 before the first).
    pub fn growth(&self) -> u64 {
        self.growth.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    const GIB: u64 = 1 << 30;

    /// A scratch folder under the host temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "jan_disk_test_{}_{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_limits_match_the_design() {
        assert_eq!(DISK_LIMIT_BYTES, GIB);
        assert_eq!(VOLUME_LIMIT_BYTES, 2 * GIB);
        assert_eq!(POLL_MS, 500);
    }

    #[test]
    fn nothing_stops_within_the_limits() {
        assert_eq!(disk_stop(Some(10 * GIB), Some(9 * GIB), GIB / 2), None);
        assert_eq!(disk_stop(Some(10 * GIB), Some(8 * GIB), GIB), None);
    }

    #[test]
    fn the_folder_limit_stops_past_one_gib() {
        assert_eq!(disk_stop(None, None, GIB + 1), Some(DiskStop::Folder));
        assert_eq!(
            disk_stop(Some(10 * GIB), Some(10 * GIB), GIB + 1),
            Some(DiskStop::Folder)
        );
    }

    #[test]
    fn the_volume_backstop_stops_past_two_gib_of_free_space() {
        assert_eq!(
            disk_stop(Some(10 * GIB), Some(8 * GIB - 1), 0),
            Some(DiskStop::Volume)
        );
        assert_eq!(disk_stop(Some(10 * GIB), Some(8 * GIB), 0), None);
    }

    #[test]
    fn the_folder_limit_wins_when_both_are_past() {
        assert_eq!(
            disk_stop(Some(10 * GIB), Some(GIB), 2 * GIB),
            Some(DiskStop::Folder)
        );
    }

    #[test]
    fn unknown_or_growing_free_space_never_stops() {
        assert_eq!(disk_stop(None, Some(0), 0), None);
        assert_eq!(disk_stop(Some(10 * GIB), None, 0), None);
        assert_eq!(disk_stop(Some(GIB), Some(10 * GIB), 0), None);
    }

    #[test]
    fn walks_are_at_least_20_ms_and_twice_the_last_walk_apart() {
        assert_eq!(walk_gap(Duration::ZERO), WALK_FLOOR);
        assert_eq!(WALK_FLOOR, Duration::from_millis(20));
        assert_eq!(
            walk_gap(Duration::from_millis(9)),
            Duration::from_millis(20)
        );
        assert_eq!(
            walk_gap(Duration::from_millis(15)),
            Duration::from_millis(30)
        );
        assert_eq!(
            walk_gap(Duration::from_millis(300)),
            Duration::from_millis(600)
        );
        assert_eq!(walk_gap(Duration::from_secs(3)), Duration::from_secs(6));
    }

    /// Windows lists a file still open for writing at the size its directory
    /// entry last had (0 for a new file) until it is closed. The disk check must
    /// see the bytes anyway, or one long write would get past the limit.
    #[test]
    fn growth_counts_a_file_that_is_still_being_written() {
        use std::io::Write;
        let dir = Scratch::new();
        std::fs::write(dir.0.join("old.txt"), b"12345").unwrap();
        let before = total_size(&snapshot(&dir.0).unwrap());
        assert_eq!(before, 5);

        let mut open = std::fs::File::create(dir.0.join("big.bin")).unwrap();
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..8 {
            open.write_all(&chunk).unwrap();
        }
        assert_eq!(grown_since(&dir.0, before), 8 << 20);
        drop(open);
        assert_eq!(grown_since(&dir.0, before), 8 << 20);
    }

    #[test]
    fn growth_is_zero_for_a_missing_folder_or_a_shrunk_one() {
        let dir = Scratch::new();
        assert_eq!(grown_since(&dir.0.join("gone"), 0), 0);
        std::fs::write(dir.0.join("a"), b"12").unwrap();
        assert_eq!(grown_since(&dir.0, 100), 0);
    }

    /// Reading every file's size costs more than the listing on Windows;
    /// `walk_gap` spaces the walks out by it. Printed for the record.
    #[test]
    fn growth_of_ten_thousand_files_is_measured() {
        let dir = Scratch::new();
        for i in 0..100 {
            let sub = dir.0.join(format!("d{i}"));
            std::fs::create_dir(&sub).unwrap();
            for j in 0..100 {
                std::fs::write(sub.join(format!("f{j}")), b"x").unwrap();
            }
        }
        let started = Instant::now();
        assert_eq!(grown_since(&dir.0, 0), 10_000);
        let took = started.elapsed();
        println!("growth of 10000 files measured in {took:?}");
        assert!(took < Duration::from_secs(30));
    }

    #[test]
    fn free_space_is_read_and_drops_when_a_file_is_written() {
        let dir = Scratch::new();
        let before = free_space(&dir.0).expect("free space of the temp volume");
        assert!(before > 0);
        assert_eq!(free_space(&dir.0.join("missing-folder")), None);
        // A large write lowers it (other activity on the volume adds noise, so
        // only the direction and a loose size are checked).
        let size = 64u64 << 20;
        let file = std::fs::File::create(dir.0.join("fill.bin")).unwrap();
        file.set_len(size).unwrap();
        file.sync_all().unwrap();
        drop(file);
        std::fs::write(dir.0.join("fill2.bin"), vec![1u8; size as usize]).unwrap();
        let after = free_space(&dir.0).unwrap();
        assert!(before > after, "{before} -> {after}");
    }

    #[test]
    fn the_folder_watch_publishes_growth_off_the_caller_thread() {
        let dir = Scratch::new();
        let watch = FolderWatch::start(dir.0.clone(), 0);
        std::fs::write(dir.0.join("a.bin"), vec![0u8; 4096]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while watch.growth() < 4096 {
            assert!(Instant::now() < deadline, "no walk published the growth");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(watch.growth(), 4096);
    }
}
