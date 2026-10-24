//! Sharing books: finding the synced folders on this machine ([`folders`]) and uploading to a
//! Nextcloud server for a public link ([`nextcloud`]).

pub mod folders;
pub mod nextcloud;

use std::path::{Path, PathBuf};

/// Longest file name stem [`safe_file_name`] returns, in characters.
const MAX_NAME_CHARS: usize = 120;

/// A file name stem for a book title: without the characters Windows, macOS and Nextcloud reject
/// (`\ / : * ? " < > |` and control characters), trimmed (dots too), at most 120 characters,
/// and "Book" when nothing is left.
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
    } else {
        trimmed.to_owned()
    }
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
