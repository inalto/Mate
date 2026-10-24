//! Sharing books: finding the synced folders on this machine ([`folders`]) and uploading to a
//! Nextcloud server for a public link ([`nextcloud`]).

pub mod folders;
pub mod nextcloud;

use std::path::{Path, PathBuf};

/// Longest file name stem [`safe_file_name`] returns, in characters.
const MAX_NAME_CHARS: usize = 120;

/// A file name stem for a book title: without the characters Windows, macOS and Nextcloud reject
/// (`\ / : * ? " < > |` and control characters), trimmed (dots too), at most 120 characters,
/// and "Book" when nothing is left. A name Windows reserves for devices (`CON`, `PRN`, `AUX`,
/// `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, any case) gets a trailing `_`.
pub fn safe_file_name(title: &str) -> String {
    let kept: String = title
        .chars()
        .filter(|c| {
            !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = kept.trim_matches(|c: char| c.is_whitespace() || c == '.');
    if trimmed.is_empty() {
        "Book".to_owned()
    } else if is_reserved_on_windows(trimmed) {
        format!("{trimmed}_")
    } else {
        trimmed.to_owned()
    }
}

fn is_reserved_on_windows(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => ["COM", "LPT"].iter().any(|p| {
            upper
                .strip_prefix(p)
                .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
        }),
    }
}

/// The name a book is uploaded under: `<safe title>-<first 8 characters of its id>.mate`, so
/// two books with the same title never replace each other.
pub fn remote_file_name(title: &str, unit_id: &str) -> String {
    let id: String = unit_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(8)
        .collect();
    format!("{}-{id}.mate", safe_file_name(title))
}

/// `<dir>/<stem>.mate`, or `<dir>/<stem> (2).mate`, `(3)`, … when the name is taken.
pub fn unique_archive_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.mate"));
    if !first.exists() {
        return first;
    }
    (2u32..)
        .map(|n| dir.join(format!("{stem} ({n}).mate")))
        .find(|p| !p.exists())
        .expect("some numbered name is free")
}
