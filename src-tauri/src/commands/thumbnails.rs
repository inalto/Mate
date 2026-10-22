use std::fs;
use std::path::Path;

use tauri::State;

use crate::state::AppState;

/// Thumbnails are 320 px wide WebP files; anything near this size is not one.
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;

/// Page ids are UUIDs; reject anything that could escape the thumbnails directory.
fn valid_page_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Writes `<dir>/<page_id>.webp` atomically (temp file + rename) and returns its path.
fn write_thumbnail(dir: &Path, page_id: &str, bytes: &[u8]) -> Result<String, String> {
    if !valid_page_id(page_id) {
        return Err("invalid page id".into());
    }
    if bytes.is_empty() || bytes.len() > MAX_THUMBNAIL_BYTES {
        return Err("invalid thumbnail size".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{page_id}.webp"));
    let tmp = dir.join(format!("{page_id}.webp.tmp"));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn save_thumbnail(
    state: State<'_, AppState>,
    page_id: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let path = write_thumbnail(&state.data_dir.join("thumbnails"), &page_id, &bytes)?;
    state
        .storage
        .lock()
        .map_err(|e| e.to_string())?
        .bump_thumbnail_version(&page_id)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_atomically_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("mate-thumb-{}", std::process::id()));
        let path = write_thumbnail(&dir, "abc-123", b"one").unwrap();
        assert!(path.ends_with("abc-123.webp"));
        write_thumbnail(&dir, "abc-123", b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(!dir.join("abc-123.webp.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_path_traversal_and_empty_payloads() {
        let dir = std::env::temp_dir().join("mate-thumb-reject");
        assert!(write_thumbnail(&dir, "../evil", b"x").is_err());
        assert!(write_thumbnail(&dir, "", b"x").is_err());
        assert!(write_thumbnail(&dir, "ok", b"").is_err());
    }
}
