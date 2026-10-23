use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

/// Largest export file accepted from the frontend.
const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;

/// `title` slugified (`[^a-z0-9]+` → `-`, trimmed, at most 60 chars) plus `.ext`, or
/// `mate-export-YYYY-MM-DD.ext` when nothing usable remains. Mirrors `pageExportFilename`.
pub fn export_filename(title: &str, ext: &str) -> String {
    let lower = title.to_lowercase();
    let mut slug = String::new();
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(60).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        let today = &mate_core::model::now_iso()[..10];
        format!("mate-export-{today}.{ext}")
    } else {
        format!("{slug}.{ext}")
    }
}

/// Save-dialog filter for a file name, chosen by its extension.
fn filter_for(name: &str) -> Option<(&'static str, &'static str)> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some(("PNG image", "png")),
        "svg" => Some(("SVG image", "svg")),
        "mate" => Some(("Mate archive", "mate")),
        "zip" => Some(("Zip archive", "zip")),
        _ => None,
    }
}

/// Writes `bytes` to `path` via a sibling temp file and a rename, so a failed write never
/// leaves a truncated file behind.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "invalid export path".to_string())?
        .to_string_lossy();
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    let written = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all() // data on disk before the rename makes it visible
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    // Make the rename itself durable (directories cannot be opened for sync on Windows).
    #[cfg(unix)]
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty())
        && let Ok(d) = fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Shows a native save dialog (off the async runtime) and returns the chosen path.
pub async fn ask_save_path(
    app: AppHandle,
    suggested_name: String,
) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(&suggested_name);
        if let Some((label, ext)) = filter_for(&suggested_name) {
            dialog = dialog.add_filter(label, &[ext]);
        }
        dialog
            .blocking_save_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves an exported file. The raw request body is the file content; the `x-suggested-name`
/// header is the default file name. Returns the written path, or `None` if cancelled.
#[tauri::command]
pub async fn write_export_file(
    app: AppHandle,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES {
        return Err("invalid export size".into());
    }
    let suggested_name = request
        .headers()
        .get("x-suggested-name")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or("mate-export")
        .to_string();
    let bytes = bytes.clone();
    let Some(path) = ask_save_path(app, suggested_name).await? else {
        return Ok(None);
    };
    write_atomically(&path, &bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_slugifies_or_falls_back_to_date() {
        assert_eq!(
            export_filename("My Notes: Week 1!", "png"),
            "my-notes-week-1.png"
        );
        assert_eq!(
            export_filename("  --  ", "mate").len(),
            "mate-export-2026-10-22.mate".len()
        );
        assert!(export_filename("", "svg").starts_with("mate-export-"));
        assert_eq!(
            export_filename(&"a".repeat(100), "png"),
            format!("{}.png", "a".repeat(60))
        );
    }

    #[test]
    fn filter_follows_extension() {
        assert_eq!(filter_for("x.PNG"), Some(("PNG image", "png")));
        assert_eq!(filter_for("x.mate"), Some(("Mate archive", "mate")));
        assert_eq!(filter_for("x"), None);
    }

    #[test]
    fn failed_rename_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("mate-export-fail-{}", std::process::id()));
        let target = dir.join("out.zip");
        fs::create_dir_all(&target).unwrap(); // a directory in the way makes the rename fail
        assert!(write_atomically(&target, b"x").is_err());
        assert!(!dir.join("out.zip.tmp").exists());
        assert!(target.is_dir());
    }

    #[test]
    fn writes_atomically() {
        let dir = std::env::temp_dir().join(format!("mate-export-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.svg");
        write_atomically(&path, b"one").unwrap();
        write_atomically(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(!dir.join("out.svg.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
