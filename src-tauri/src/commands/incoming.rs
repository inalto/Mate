//! Files other apps hand to Mate on Android ("Open with" from Files, Drive, mail...).
//!
//! Design (Phase 11 Task 6): Android delivers the intent's data URI as `RunEvent::Opened`
//! (verified on tauri 2.12 in Task 3), usually as a `content://` URI that is not a path. The
//! bytes are read here in Rust through `tauri-plugin-fs` (`FsExt::fs().open` with
//! `FilePath::Url`, which asks the plugin's Kotlin side for a file descriptor), so a large file
//! never crosses the IPC bridge and the frontend needs no new handler. The bytes are stashed
//! as `data_dir/incoming/<uuid>/<name>` and the stashed path goes into the one router,
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

/// The error for a file over [`MAX_INCOMING_BYTES`].
fn too_large() -> String {
    format!("files over {} MiB are not opened", MAX_INCOMING_BYTES / (1024 * 1024))
}

/// Writes `bytes` to `dir/<uuid>/<sanitised name>` (creating the folders) and returns that path.
/// The per-open folder keeps names unique while the file keeps the name the user sees in the
/// import dialog and the book title. Refuses more than [`MAX_INCOMING_BYTES`].
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn stash_opened_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() > MAX_INCOMING_BYTES {
        return Err(too_large());
    }
    let folder = dir.join(mate_core::model::new_id());
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join(sanitize_name(name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// When an entry of `incoming/` was last touched: a file's mtime; for a per-open folder the
/// newest mtime of its entries, or the folder's own when it is empty.
fn last_touched(path: &Path, meta: &std::fs::Metadata) -> Option<std::time::SystemTime> {
    if !meta.is_dir() {
        return meta.modified().ok();
    }
    let newest = std::fs::read_dir(path)
        .ok()?
        .flatten()
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max();
    newest.or_else(|| meta.modified().ok())
}

/// Deletes the per-open folders (and any stray files) in `dir` last touched more than
/// `older_than` ago; returns how many entries went. A missing folder or an entry that cannot be
/// removed is ignored.
pub fn prune_incoming(dir: &Path, older_than: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let old = last_touched(&path, &meta)
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > older_than);
        if !old {
            continue;
        }
        let gone = if meta.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if gone.is_ok() {
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
    let name = segment_name(uri_segment);
    let is_pdf = Path::new(&name).extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if is_pdf || is_import_path(&name) {
        return Some(name);
    }
    sniff_extension(bytes).map(|ext| format!("{name}.{ext}"))
}

/// The last segment of a URI as a file name: percent-decoded, last path component, sanitised.
fn segment_name(uri_segment: &str) -> String {
    let decoded = percent_decode(uri_segment);
    sanitize_name(decoded.rsplit(['/', '\\']).next().unwrap_or(""))
}

/// The name to stash a picked image under: the URI's last segment, sanitised, keeping its own
/// image extension or given the one of the content (PNG, JPEG, GIF, WebP, SVG, as the asset
/// store sniffs them). `None` when the content is not an image.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn image_name_for(uri_segment: &str, bytes: &[u8]) -> Option<String> {
    use mate_core::assets::{AssetKind, sniff};
    let kind = sniff(bytes).filter(|k| *k != AssetKind::Pdf)?;
    let name = segment_name(uri_segment);
    let has_image_ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["png", "jpg", "jpeg", "gif", "webp", "svg"].iter().any(|x| e.eq_ignore_ascii_case(x)));
    Some(if has_image_ext { name } else { format!("{name}.{}", kind.ext()) })
}

/// The name to stash a picked file under: [`name_for`] (PDFs and notebooks), else
/// [`image_name_for`], else the bare segment, which the command it goes to then rejects.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn picked_name(uri_segment: &str, bytes: &[u8]) -> String {
    name_for(uri_segment, bytes)
        .or_else(|| image_name_for(uri_segment, bytes))
        .unwrap_or_else(|| segment_name(uri_segment))
}

/// A path the commands can hand to `std::fs`: a picked `content://` URI (what the dialog plugin
/// returns on Android) is read, stashed as `data_dir/incoming/<uuid>/<name>` (pruned like files
/// opened from other apps) and the stashed path returned; anything else is a path already and
/// comes back unchanged. On desktop nothing is ever read. Blocking: call it off the main thread.
pub fn materialize(app: &tauri::AppHandle, data_dir: &Path, path_or_uri: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    return materialize_with(data_dir, path_or_uri, |url| read_content_uri(app, url));
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, data_dir);
        Ok(PathBuf::from(path_or_uri))
    }
}

/// [`materialize`] with the reader passed in, so it can be tested without a device.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn materialize_with(
    data_dir: &Path,
    path_or_uri: &str,
    read: impl FnOnce(&tauri::Url) -> Result<Vec<u8>, String>,
) -> Result<PathBuf, String> {
    if !path_or_uri.starts_with("content://") {
        return Ok(PathBuf::from(path_or_uri));
    }
    let url = tauri::Url::parse(path_or_uri).map_err(|e| e.to_string())?;
    let bytes = read(&url)?;
    if bytes.len() > MAX_INCOMING_BYTES {
        return Err(too_large());
    }
    let name = picked_name(last_segment(&url), &bytes);
    let path = stash_opened_file(&data_dir.join(INCOMING_DIR), &name, &bytes)?;
    log::info!("mate: picked {url} as {}", path.display());
    Ok(path)
}

/// The last non-empty path segment of `url`, or `""`.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn last_segment(url: &tauri::Url) -> &str {
    url.path_segments().and_then(|mut s| s.rfind(|p| !p.is_empty())).unwrap_or("")
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
    use tauri::Manager;
    let bytes = read_content_uri(app, url)?;
    let name = name_for(last_segment(url), &bytes).ok_or("not a file Mate opens")?;
    let dir = app.state::<crate::state::AppState>().data_dir.join(INCOMING_DIR);
    stash_opened_file(&dir, &name, &bytes)
}

/// The bytes behind a `content://` URI, through the fs plugin; refuses more than
/// [`MAX_INCOMING_BYTES`] before anything parses them. Blocking.
#[cfg(target_os = "android")]
fn read_content_uri(app: &tauri::AppHandle, url: &tauri::Url) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    let mut opts = OpenOptions::new();
    opts.read(true);
    let file = app.fs().open(FilePath::Url(url.clone()), opts).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_INCOMING_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_INCOMING_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
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
    fn stash_writes_the_sanitised_name_in_a_folder_of_its_own() {
        let d = temp("stash");
        let dir = d.join(INCOMING_DIR); // created on demand
        let a = stash_opened_file(&dir, "../x.pdf", b"%PDF-1.4").unwrap();
        let b = stash_opened_file(&dir, "../x.pdf", b"%PDF-1.4").unwrap();
        assert_ne!(a, b);
        for p in [&a, &b] {
            // incoming/<uuid>/<name>: the name the user sees carries no uuid.
            assert_eq!(p.parent().unwrap().parent().unwrap(), dir);
            assert_eq!(p.file_name().unwrap().to_string_lossy(), "_x.pdf");
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
    fn prune_removes_old_folders_and_stray_files_and_keeps_fresh_ones() {
        let d = temp("prune");
        let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        let age = |p: &Path| fs::File::options().write(true).open(p).unwrap().set_modified(two_days_ago).unwrap();
        let old = stash_opened_file(&d, "old.pdf", b"x").unwrap();
        age(&old);
        let fresh = stash_opened_file(&d, "fresh.pdf", b"x").unwrap();
        let stray = d.join("stray.pdf");
        fs::write(&stray, b"x").unwrap();
        age(&stray);
        fs::create_dir(d.join("empty")).unwrap(); // fresh folder mtime: kept
        assert_eq!(prune_incoming(&d, KEEP_INCOMING), 2);
        assert!(!old.parent().unwrap().exists() && !stray.exists());
        assert!(fresh.exists() && d.join("empty").exists());
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

    const PNG_HEAD: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const JPEG_HEAD: &[u8] = b"\xFF\xD8\xFF\xE0\0\x10JFIF\0";

    #[test]
    fn image_name_gets_the_extension_of_its_content() {
        assert_eq!(image_name_for("image%3A1000000041", PNG_HEAD).as_deref(), Some("image_1000000041.png"));
        assert_eq!(image_name_for("41", JPEG_HEAD).as_deref(), Some("41.jpg"));
        assert_eq!(image_name_for("41", b"<svg xmlns='http://www.w3.org/2000/svg'/>").as_deref(), Some("41.svg"));
        assert_eq!(image_name_for("photo.JPG", JPEG_HEAD).as_deref(), Some("photo.JPG")); // its own kept
        assert_eq!(image_name_for("41", b"hello world"), None);
    }

    #[test]
    fn picked_name_prefers_notebooks_and_pdfs_then_images_then_the_segment() {
        assert_eq!(picked_name("msf%3A7", b"%PDF-1.7\n"), "msf_7.pdf");
        assert_eq!(picked_name("image%3A7", PNG_HEAD), "image_7.png");
        assert_eq!(picked_name("7", b"hello"), "7"); // the command then rejects it
    }

    #[test]
    fn materialize_leaves_a_plain_path_alone() {
        let d = temp("materialize-plain");
        let never = |_: &tauri::Url| -> Result<Vec<u8>, String> { panic!("a path is not read") };
        for s in [r"C:\Users\me\Pictures\cat.png", "/storage/emulated/0/Download/cat.png", "file:///tmp/x.pdf"] {
            assert_eq!(materialize_with(&d, s, never).unwrap(), PathBuf::from(s));
        }
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn materialize_stashes_a_content_uri_under_incoming() {
        let d = temp("materialize-uri");
        let uri = "content://com.android.providers.media.documents/document/image%3A1000000041";
        let p = materialize_with(&d, uri, |u| {
            assert_eq!(u.as_str(), uri);
            Ok(PNG_HEAD.to_vec())
        })
        .unwrap();
        assert_eq!(p.parent().unwrap().parent().unwrap(), d.join(INCOMING_DIR));
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "image_1000000041.png");
        assert_eq!(fs::read(&p).unwrap(), PNG_HEAD);
        let err = materialize_with(&d, "content://x/y", |_| Err("denied".into())).unwrap_err();
        assert!(err.contains("denied"), "{err}");
        let big = materialize_with(&d, "content://x/big", |_| Ok(vec![0; MAX_INCOMING_BYTES + 1]));
        assert!(big.is_err());
        let _ = fs::remove_dir_all(&d);
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
