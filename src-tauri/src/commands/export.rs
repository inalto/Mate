use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use std::time::Duration;

use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};
#[cfg(desktop)]
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

/// Folder under the data directory that holds exports on mobile until they are shared.
pub const EXPORTS_DIR: &str = "exports";

/// Exports older than this are deleted at startup (the share target has its own copy).
pub const KEEP_EXPORTS: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Where an export is written on mobile: `data_dir/exports/<export_filename(title, ext)>`.
pub fn mobile_export_path(data_dir: &Path, title: &str, ext: &str) -> PathBuf {
    data_dir.join(EXPORTS_DIR).join(export_filename(title, ext))
}

/// The mobile path for a save-dialog suggestion: its stem and extension go through
/// `export_filename`, so names the commands suggest come back unchanged and anything else is
/// slugified into `exports/`. A missing extension becomes `bin`.
#[cfg_attr(desktop, allow(dead_code))]
pub fn mobile_save_path(data_dir: &Path, suggested_name: &str) -> PathBuf {
    let name = Path::new(suggested_name);
    let stem = name
        .file_stem()
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let ext: String = name
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(10)
        .collect();
    let ext = if ext.is_empty() {
        "bin".to_string()
    } else {
        ext
    };
    mobile_export_path(data_dir, &stem, &ext)
}

/// MIME type the share sheet is given for an exported file, chosen by its extension.
#[cfg_attr(desktop, allow(dead_code))]
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "tex" => "application/x-tex",
        "mate" => "application/x-mate-archive",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Save-dialog filter for a file name, chosen by its extension.
#[cfg_attr(mobile, allow(dead_code))]
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
#[cfg(desktop)]
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

/// Mobile has no save dialog: exports go to `data_dir/exports/` and then to the share sheet.
#[cfg(mobile)]
pub async fn ask_save_path(
    app: AppHandle,
    suggested_name: String,
) -> Result<Option<PathBuf>, String> {
    use tauri::Manager;
    let path = mobile_save_path(
        &app.state::<crate::state::AppState>().data_dir,
        &suggested_name,
    );
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(Some(path))
}

/// Opens the Android share sheet for `path` (tauri-plugin-sharekit). Resolves once the sheet is
/// dismissed; dismissing it without picking a target is not an error.
#[cfg(mobile)]
pub async fn share_file(app: &AppHandle, path: &Path, mime: &str) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_sharekit::{ShareExt, ShareFileOptions};
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let app = app.clone();
    let url = path.to_string_lossy().into_owned();
    let options = ShareFileOptions {
        mime_type: Some(mime.to_string()),
        title: path.file_name().map(|n| n.to_string_lossy().into_owned()),
        position: None,
    };
    // The plugin call blocks until the share activity returns.
    let result =
        tauri::async_runtime::spawn_blocking(move || app.share().share_file(window, url, options))
            .await
            .map_err(|e| e.to_string())?;
    match result {
        Ok(()) => Ok(()),
        // The chooser reports RESULT_CANCELED whether or not a target was picked.
        Err(e) if e.to_string().contains("cancelled") => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// After an export is written: on mobile it goes to the share sheet; nothing to do on desktop.
pub async fn after_export(app: &AppHandle, path: &Path) -> Result<(), String> {
    #[cfg(mobile)]
    {
        share_file(app, path, mime_for(path)).await
    }
    #[cfg(desktop)]
    {
        let _ = (app, path);
        Ok(())
    }
}

/// The file content of a raw-body request. Android has no custom-protocol IPC (the webview
/// cannot read request bodies), so there a `Uint8Array` arrives as a JSON array of numbers.
pub fn body_bytes(body: &InvokeBody) -> Option<Vec<u8>> {
    match body {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect(),
        InvokeBody::Json(_) => None,
    }
}

/// Saves an exported file. The raw request body is the file content; the `x-suggested-name`
/// header is the default file name. Returns the written path, or `None` if cancelled.
#[tauri::command]
pub async fn write_export_file(
    app: AppHandle,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    let Some(bytes) = body_bytes(request.body()) else {
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
    let Some(path) = ask_save_path(app.clone(), suggested_name).await? else {
        return Ok(None);
    };
    write_atomically(&path, &bytes)?;
    after_export(&app, &path).await?;
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
    fn mobile_path_is_the_desktop_name_in_exports() {
        let data = Path::new("/data/mate");
        assert_eq!(
            mobile_export_path(data, "My Notes: Week 1!", "pdf"),
            data.join("exports").join("my-notes-week-1.pdf")
        );
        // Empty or punctuation-only titles get the same fallback name as desktop.
        assert_eq!(
            mobile_export_path(data, "", "pdf"),
            data.join("exports").join(export_filename("", "pdf"))
        );
        assert_eq!(
            mobile_export_path(data, " -- ", "mate"),
            data.join("exports").join(export_filename("", "mate"))
        );
    }

    #[test]
    fn mobile_save_path_keeps_the_suggested_name() {
        let data = Path::new("/data/mate");
        let exports = data.join("exports");
        // What the commands suggest comes back unchanged, fallback names included.
        for name in [
            "my-notes.pdf".to_string(),
            "mate-backup-2026-10-26.zip".to_string(),
            export_filename("", "mate"),
            export_filename("?!", "png"),
        ] {
            assert_eq!(mobile_save_path(data, &name), exports.join(&name));
        }
        // Anything else is slugified like a title, and never leaves `exports/`.
        assert_eq!(
            mobile_save_path(data, "../../My Page.PDF"),
            exports.join("my-page.pdf")
        );
        assert_eq!(
            mobile_save_path(data, "mate-export"),
            exports.join("mate-export.bin")
        );
        assert_eq!(mobile_save_path(data, "x.p/df"), exports.join("df.bin"));
    }

    #[test]
    fn body_bytes_accepts_raw_and_json_arrays() {
        assert_eq!(
            body_bytes(&InvokeBody::Raw(vec![1, 2, 255])),
            Some(vec![1, 2, 255])
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!([37, 80, 68, 70]))),
            Some(b"%PDF".to_vec())
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!([1, 256]))),
            None
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!([1, -1]))),
            None
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!({"0": 1}))),
            None
        );
    }

    #[test]
    fn mime_follows_extension() {
        assert_eq!(mime_for(Path::new("a.pdf")), "application/pdf");
        assert_eq!(mime_for(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a.tex")), "application/x-tex");
        assert_eq!(mime_for(Path::new("a.mate")), "application/x-mate-archive");
        assert_eq!(mime_for(Path::new("a.zip")), "application/zip");
        assert_eq!(mime_for(Path::new("a")), "application/octet-stream");
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
