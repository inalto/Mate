//! Files other apps hand to Mate on Android ("Open with" from Files, Drive, mail...).
//!
//! Design (Phase 11 Task 6): Android delivers the intent's data URI as `RunEvent::Opened`
//! (verified on tauri 2.12 in Task 3), usually as a `content://` URI that is not a path. The
//! bytes are read here in Rust through `tauri-plugin-fs` (`FsExt::fs().open` with
//! `FilePath::Url`, which asks the plugin's Kotlin side for a file descriptor), so a large file
//! never crosses the IPC bridge and the frontend needs no new handler. The bytes are stashed
//! under `data_dir/incoming/` and the stashed path goes into the one router,
//! [`super::open_files::file_opened`], exactly like a path opened on desktop.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::open_files::is_import_path;

/// Largest file accepted from another app. PDFs are bounded again by the PDF import limit.
pub const MAX_INCOMING_BYTES: usize = 200 * 1024 * 1024;

/// Folder under the data dir holding received files until they are imported.
pub const INCOMING_DIR: &str = "incoming";

/// Received files older than this are deleted at startup.
pub const KEEP_INCOMING: Duration = Duration::from_secs(24 * 60 * 60);

/// A file name safe to put in a folder: keeps `[A-Za-z0-9._-]`, turns every run of other
/// characters into one `_`, drops leading dots, keeps at most 100 characters (the extension
/// survives the cut) and is never empty (`file`).
pub fn sanitize_name(name: &str) -> String {
    const MAX: usize = 100;
    let mut out = String::with_capacity(name.len().min(4 * MAX));
    let mut replaced = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            replaced = false;
        } else if !replaced {
            out.push('_');
            replaced = true;
        }
    }
    let mut out = out.trim_start_matches('.').to_owned();
    if out.len() > MAX {
        // ASCII only from here, so byte offsets are character offsets.
        out = match out.rfind('.') {
            Some(dot) if dot > 0 && out.len() - dot <= 17 => {
                let ext = out[dot..].to_owned();
                format!("{}{ext}", &out[..MAX - ext.len()])
            }
            _ => out[..MAX].to_owned(),
        };
    }
    if out.is_empty() { "file".to_owned() } else { out }
}

/// Writes `bytes` to `dir/<uuid>-<sanitised name>` (creating `dir`) and returns that path.
/// Refuses more than [`MAX_INCOMING_BYTES`].
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn stash_opened_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() > MAX_INCOMING_BYTES {
        return Err(format!("files over {} MiB are not opened", MAX_INCOMING_BYTES / (1024 * 1024)));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}", mate_core::model::new_id(), sanitize_name(name)));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Deletes the files in `dir` last modified more than `older_than` ago; returns how many. A
/// missing folder or a file that cannot be removed is ignored.
pub fn prune_incoming(dir: &Path, older_than: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > older_than);
        if meta.is_file() && old && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The name to stash a received file under: the last segment of its URI (percent-decoded, last
/// path component), sanitised; when that has no extension the router knows, the extension
/// matching the content is appended. `None` when the content is nothing Mate opens.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn name_for(uri_segment: &str, bytes: &[u8]) -> Option<String> {
    let decoded = percent_decode(uri_segment);
    let name = sanitize_name(decoded.rsplit(['/', '\\']).next().unwrap_or(""));
    let is_pdf = Path::new(&name).extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if is_pdf || is_import_path(&name) {
        return Some(name);
    }
    sniff_extension(bytes).map(|ext| format!("{name}.{ext}"))
}

/// The extension of the format `bytes` holds, among those the router opens.
fn sniff_extension(bytes: &[u8]) -> Option<&'static str> {
    use mate_core::import::{CAB_MAGIC, ImportSource, ONE_MAGIC};
    if bytes.starts_with(b"%PDF") {
        return Some("pdf");
    }
    if bytes.starts_with(CAB_MAGIC) {
        return Some("onepkg");
    }
    if bytes.starts_with(&ONE_MAGIC) {
        return Some("one");
    }
    // A Mate archive is a zip whose `manifest.json` the archive import checks in full.
    if bytes.starts_with(b"PK")
        && zip::ZipArchive::new(std::io::Cursor::new(bytes)).is_ok_and(|z| z.index_for_name("manifest.json").is_some())
    {
        return Some("mate");
    }
    match mate_core::import::sniff(bytes, "file").ok()? {
        ImportSource::GoodNotes => Some("goodnotes"),
        ImportSource::Notability => Some("note"),
        ImportSource::OneNote => Some("one"),
        ImportSource::Freenotes => Some("freenotes"),
        ImportSource::SamsungNotes => Some("sdocx"),
    }
}

/// `%XX` escapes decoded; invalid escapes are kept as they are, invalid UTF-8 replaced.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (b.get(i + 1).and_then(|&c| hex(c)), b.get(i + 2).and_then(|&c| hex(c)))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A `content://` URI handed to Mate (Android `RunEvent::Opened`): read it off the event loop,
/// stash it and route the stashed path. Failures are logged; the user simply sees nothing open.
#[cfg(target_os = "android")]
pub fn content_uri_opened(app: &tauri::AppHandle, url: tauri::Url) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || match receive(&app, &url) {
        Ok(path) => {
            log::info!("mate: received {url} as {}", path.display());
            super::open_files::file_opened(&app, path.to_string_lossy().into_owned());
        }
        Err(e) => log::warn!("mate: could not open {url}: {e}"),
    });
}

/// Reads `url` through the fs plugin (a file descriptor from the content resolver) and stashes it.
#[cfg(target_os = "android")]
fn receive(app: &tauri::AppHandle, url: &tauri::Url) -> Result<PathBuf, String> {
    use std::io::Read;
    use tauri::Manager;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    let mut opts = OpenOptions::new();
    opts.read(true);
    let file = app.fs().open(FilePath::Url(url.clone()), opts).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_INCOMING_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let segment = url.path_segments().and_then(|mut s| s.rfind(|p| !p.is_empty())).unwrap_or("");
    let name = name_for(segment, &bytes).ok_or("not a file Mate opens")?;
    let dir = app.state::<crate::state::AppState>().data_dir.join(INCOMING_DIR);
    stash_opened_file(&dir, &name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::SystemTime;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mate-incoming-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sanitize_name_strips_separators_and_leading_dots() {
        let s = sanitize_name("../../x.pdf");
        assert!(!s.contains('/') && !s.contains('\\'), "{s}");
        assert!(!s.starts_with('.'), "{s}");
        assert!(s.ends_with("x.pdf"), "{s}");
        assert_eq!(sanitize_name("a\\b/c d.note"), "a_b_c_d.note");
        assert_eq!(sanitize_name("é  ü.pdf"), "_.pdf"); // a run collapses to one `_`
        assert_eq!(sanitize_name("Maths-1_v2.goodnotes"), "Maths-1_v2.goodnotes");
    }

    #[test]
    fn sanitize_name_is_never_empty() {
        assert_eq!(sanitize_name(""), "file");
        assert_eq!(sanitize_name("..."), "file");
        assert_eq!(sanitize_name("."), "file");
    }

    #[test]
    fn sanitize_name_caps_length_and_keeps_the_extension() {
        let long = format!("{}.pdf", "a".repeat(300));
        let s = sanitize_name(&long);
        assert_eq!(s.len(), 100);
        assert!(s.ends_with(".pdf"));
        assert_eq!(sanitize_name(&"b".repeat(300)).len(), 100);
    }

    #[test]
    fn stash_writes_a_unique_file_in_dir() {
        let d = temp("stash");
        let dir = d.join(INCOMING_DIR); // created on demand
        let a = stash_opened_file(&dir, "../x.pdf", b"%PDF-1.4").unwrap();
        let b = stash_opened_file(&dir, "../x.pdf", b"%PDF-1.4").unwrap();
        assert_ne!(a, b);
        for p in [&a, &b] {
            assert_eq!(p.parent().unwrap(), dir);
            assert!(p.file_name().unwrap().to_string_lossy().ends_with("-_x.pdf"), "{}", p.display());
            assert_eq!(fs::read(p).unwrap(), b"%PDF-1.4");
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stash_refuses_files_over_the_limit() {
        let d = temp("limit");
        let big = vec![0u8; MAX_INCOMING_BYTES + 1];
        assert!(stash_opened_file(&d, "big.pdf", &big).is_err());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_removes_old_files_and_keeps_fresh_ones() {
        let d = temp("prune");
        let old = d.join("old.pdf");
        let fresh = d.join("fresh.pdf");
        fs::write(&old, b"x").unwrap();
        fs::write(&fresh, b"x").unwrap();
        let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        fs::File::options().write(true).open(&old).unwrap().set_modified(two_days_ago).unwrap();
        assert_eq!(prune_incoming(&d, KEEP_INCOMING), 1);
        assert!(!old.exists() && fresh.exists());
        assert_eq!(prune_incoming(&d.join("missing"), KEEP_INCOMING), 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn name_keeps_a_known_extension_from_the_uri() {
        assert_eq!(
            name_for("raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2FMaths%20book.mate", b"PK\x03\x04").as_deref(),
            Some("Maths_book.mate")
        );
        assert_eq!(name_for("x.PDF", b"anything").as_deref(), Some("x.PDF"));
    }

    #[test]
    fn name_without_extension_is_sniffed_from_the_content() {
        assert_eq!(name_for("msf%3A1000000034", b"%PDF-1.7\n").as_deref(), Some("msf_1000000034.pdf"));
        assert_eq!(name_for("34", &mate_core::import::ONE_MAGIC).as_deref(), Some("34.one"));
        assert_eq!(name_for("34", &mate_archive()).as_deref(), Some("34.mate"));
        assert_eq!(name_for("34", b"hello world"), None);
        assert_eq!(name_for("34", b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0"), None); // empty zip
    }

    /// A zip carrying a `manifest.json`, as a Mate archive does.
    fn mate_archive() -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(br#"{"format":"mate-archive"}"#).unwrap();
        zip.finish().unwrap().into_inner()
    }
}
