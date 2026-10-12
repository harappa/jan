//! File names that are safe to create on every platform the python tool runs on.

/// Device names Windows resolves to a device whatever the extension, so
/// `NUL.txt` would not be an ordinary file there.
const WINDOWS_DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Reduce an attachment's name to one file name that is safe to create in a
/// directory, or `None` when nothing usable is left.
///
/// Keeps only what follows the last `/` or `\` (a name can carry a path from
/// either OS), replaces control characters and `< > : " | ? *` with `_`, drops
/// trailing dots and spaces (Windows silently strips them, which could turn a
/// name into `.` or `..`), and prefixes a Windows device name with `_`.
pub fn safe_file_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    // `.` and `..` end up empty here, as does a name of only dots and spaces.
    let trimmed = cleaned.trim_end_matches(['.', ' ']).trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    if WINDOWS_DEVICE_NAMES
        .iter()
        .any(|device| stem.trim_end().eq_ignore_ascii_case(device))
    {
        return Some(format!("_{trimmed}"));
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_part_after_the_last_separator() {
        assert_eq!(
            safe_file_name("C:\\x\\レポート.pdf").as_deref(),
            Some("レポート.pdf")
        );
        assert_eq!(safe_file_name("a/b/c.txt").as_deref(), Some("c.txt"));
        assert_eq!(safe_file_name("a\\b/c.txt").as_deref(), Some("c.txt"));
    }

    #[test]
    fn replaces_characters_windows_rejects() {
        assert_eq!(safe_file_name("a/b:c?.txt").as_deref(), Some("b_c_.txt"));
        assert_eq!(
            safe_file_name("a<b>c\"d|e*f.txt").as_deref(),
            Some("a_b_c_d_e_f.txt")
        );
        assert_eq!(
            safe_file_name("a\u{0}b\nc.txt").as_deref(),
            Some("a_b_c.txt")
        );
    }

    #[test]
    fn nothing_usable_is_none() {
        for raw in ["", ".", "..", "a/", "a\\", "dir/..", " ", "...", ". ."] {
            assert_eq!(safe_file_name(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn trailing_dots_and_spaces_are_dropped() {
        assert_eq!(safe_file_name("report. ").as_deref(), Some("report"));
        assert_eq!(safe_file_name(".env").as_deref(), Some(".env"));
    }

    #[test]
    fn windows_device_names_are_prefixed() {
        assert_eq!(safe_file_name("NUL").as_deref(), Some("_NUL"));
        assert_eq!(safe_file_name("con.txt").as_deref(), Some("_con.txt"));
        assert_eq!(safe_file_name("COM1.csv").as_deref(), Some("_COM1.csv"));
        assert_eq!(
            safe_file_name("console.txt").as_deref(),
            Some("console.txt")
        );
    }
}
