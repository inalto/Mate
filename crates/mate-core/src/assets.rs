//! Asset store: images and PDFs inserted into notes are written once to `<dir>/<uuid>.<ext>` and
//! referenced from elements by id. Binary data never enters SQLite.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use uuid::Uuid;

use crate::storage::StorageError;

/// Largest accepted image (PNG, JPEG, WebP, GIF, SVG).
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
/// Largest accepted PDF.
pub const MAX_PDF_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Png,
    Jpeg,
    Webp,
    Gif,
    Svg,
    Pdf,
}

impl AssetKind {
    pub fn ext(self) -> &'static str {
        match self {
            AssetKind::Png => "png",
            AssetKind::Jpeg => "jpg",
            AssetKind::Webp => "webp",
            AssetKind::Gif => "gif",
            AssetKind::Svg => "svg",
            AssetKind::Pdf => "pdf",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            AssetKind::Png => "image/png",
            AssetKind::Jpeg => "image/jpeg",
            AssetKind::Webp => "image/webp",
            AssetKind::Gif => "image/gif",
            AssetKind::Svg => "image/svg+xml",
            AssetKind::Pdf => "application/pdf",
        }
    }

    pub fn max_bytes(self) -> usize {
        if self == AssetKind::Pdf { MAX_PDF_BYTES } else { MAX_IMAGE_BYTES }
    }

    fn from_ext(ext: &str) -> Option<AssetKind> {
        Some(match ext {
            "png" => AssetKind::Png,
            "jpg" => AssetKind::Jpeg,
            "webp" => AssetKind::Webp,
            "gif" => AssetKind::Gif,
            "svg" => AssetKind::Svg,
            "pdf" => AssetKind::Pdf,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub id: String,
    pub path: PathBuf,
    pub mime: String,
    pub bytes: u64,
}

/// Detects the asset type from its content (never its name). SVG is recognised by a leading
/// `<svg` (or `<?xml` followed by `<svg`) since `infer` does not sniff text formats.
pub fn sniff(bytes: &[u8]) -> Option<AssetKind> {
    if let Some(t) = infer::get(bytes) {
        return match t.mime_type() {
            "image/png" => Some(AssetKind::Png),
            "image/jpeg" => Some(AssetKind::Jpeg),
            "image/webp" => Some(AssetKind::Webp),
            "image/gif" => Some(AssetKind::Gif),
            "application/pdf" => Some(AssetKind::Pdf),
            _ => None,
        };
    }
    let head = &bytes[..bytes.len().min(512)];
    let head = head.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(head);
    let lower = String::from_utf8_lossy(head).trim_start().to_ascii_lowercase();
    if lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg")) {
        Some(AssetKind::Svg)
    } else {
        None
    }
}

fn io(e: std::io::Error) -> StorageError {
    StorageError::Limit(format!("asset io error: {e}"))
}

/// Validates the size limit and writes `<dir>/<uuid>.<ext>` atomically.
pub fn save_asset(dir: &Path, bytes: &[u8], kind: AssetKind) -> Result<AssetInfo, StorageError> {
    if bytes.is_empty() {
        return Err(StorageError::Limit("empty asset".into()));
    }
    if bytes.len() > kind.max_bytes() {
        return Err(StorageError::Limit(format!(
            "asset is {} bytes (max {})",
            bytes.len(),
            kind.max_bytes()
        )));
    }
    fs::create_dir_all(dir).map_err(io)?;
    let id = Uuid::new_v4().to_string();
    let path = dir.join(format!("{id}.{}", kind.ext()));
    let tmp = dir.join(format!("{id}.tmp"));
    fs::write(&tmp, bytes).map_err(io)?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io(e)
    })?;
    Ok(AssetInfo { id, path, mime: kind.mime().into(), bytes: bytes.len() as u64 })
}

/// Sniffs `bytes` and saves them; unknown content is rejected with `StorageError::Limit`.
pub fn save_sniffed(dir: &Path, bytes: &[u8]) -> Result<AssetInfo, StorageError> {
    let kind = sniff(bytes).ok_or_else(|| StorageError::Limit("unsupported file type".into()))?;
    save_asset(dir, bytes, kind)
}

fn valid_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

fn entries(dir: &Path) -> impl Iterator<Item = (String, AssetKind, PathBuf)> {
    fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| {
        let path = e.path();
        let stem = path.file_stem()?.to_str()?.to_owned();
        let kind = AssetKind::from_ext(path.extension()?.to_str()?)?;
        valid_id(&stem).then_some((stem, kind, path))
    })
}

/// Path of asset `id`, or `None` if the id is not a UUID or no such asset exists.
pub fn asset_path(dir: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    entries(dir).find(|(i, _, _)| i == id).map(|(_, _, p)| p)
}

/// Info about asset `id`, if stored.
pub fn asset_info(dir: &Path, id: &str) -> Option<AssetInfo> {
    if !valid_id(id) {
        return None;
    }
    let (id, kind, path) = entries(dir).find(|(i, _, _)| i == id)?;
    let bytes = fs::metadata(&path).ok()?.len();
    Some(AssetInfo { id, path, mime: kind.mime().into(), bytes })
}

/// Removes asset `id`; true if a file was deleted.
pub fn delete_asset(dir: &Path, id: &str) -> bool {
    asset_path(dir, id).is_some_and(|p| fs::remove_file(p).is_ok())
}

/// Removes every stored asset whose id is not in `referenced`, except files modified within `grace`
/// (a just-inserted image may not have its element row in the database yet); returns how many
/// were removed.
pub fn gc_unreferenced(dir: &Path, referenced: &HashSet<String>, grace: Duration) -> usize {
    let recent = |p: &Path| {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .is_ok_and(|t| SystemTime::now().duration_since(t).is_ok_and(|age| age < grace))
    };
    let doomed: Vec<_> = entries(dir)
        .filter(|(id, _, p)| !referenced.contains(id) && !recent(p))
        .collect();
    doomed.into_iter().filter(|(_, _, p)| fs::remove_file(p).is_ok()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mate-assets-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn sniffs_png() {
        assert_eq!(sniff(PNG), Some(AssetKind::Png));
        assert_eq!(sniff(b"%PDF-1.7\n"), Some(AssetKind::Pdf));
        assert_eq!(sniff(b"\xEF\xBB\xBF  <svg xmlns=\"x\"/>"), Some(AssetKind::Svg));
        assert_eq!(sniff(b"GIF89a\x01\x00\x01\x00"), Some(AssetKind::Gif));
    }

    #[test]
    fn rejects_unknown_type() {
        assert_eq!(sniff(b"hello world"), None);
        let dir = tmp("unknown");
        assert!(matches!(save_sniffed(&dir, b"hello world"), Err(StorageError::Limit(_))));
        assert!(matches!(
            save_asset(&dir, &vec![0; MAX_IMAGE_BYTES + 1], AssetKind::Png),
            Err(StorageError::Limit(_))
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saves_atomically_and_resolves() {
        let dir = tmp("save");
        let info = save_sniffed(&dir, PNG).unwrap();
        assert_eq!(info.mime, "image/png");
        assert_eq!(info.bytes, PNG.len() as u64);
        assert_eq!(fs::read(&info.path).unwrap(), PNG);
        assert_eq!(asset_path(&dir, &info.id), Some(info.path.clone()));
        assert_eq!(asset_path(&dir, "../etc/passwd"), None);
        assert_eq!(asset_path(&dir, "not-a-uuid"), None);
        assert!(!fs::read_dir(&dir).unwrap().any(|e| e.unwrap().path().extension().is_some_and(|x| x == "tmp")));
        assert!(delete_asset(&dir, &info.id));
        assert_eq!(asset_path(&dir, &info.id), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gc_skips_recent_files() {
        let dir = tmp("gc-recent");
        let fresh = save_sniffed(&dir, PNG).unwrap();
        let refs = HashSet::new();
        assert_eq!(gc_unreferenced(&dir, &refs, Duration::from_secs(3600)), 0);
        assert!(fresh.path.exists());
        assert_eq!(gc_unreferenced(&dir, &refs, Duration::ZERO), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gc_removes_only_unreferenced() {
        let dir = tmp("gc");
        let keep = save_sniffed(&dir, PNG).unwrap();
        let drop = save_sniffed(&dir, PNG).unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        let refs: HashSet<String> = [keep.id.clone()].into();
        assert_eq!(gc_unreferenced(&dir, &refs, Duration::ZERO), 1);
        assert!(keep.path.exists());
        assert!(!drop.path.exists());
        assert!(dir.join("notes.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
