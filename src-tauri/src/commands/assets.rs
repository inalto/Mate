use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mate_core::assets::{self, AssetInfo, MAX_ASSET_BYTES};
use mate_core::recording::RecordingDir;
use mate_core::storage::Storage;
use tauri::{AppHandle, Manager, State};
use tauri::ipc::{Request, Response};

use super::incoming::materialize;
use super::ipc_body::body_bytes;

use crate::state::AppState;

/// Files younger than this are never collected: their element rows may still be queued.
const GC_GRACE: Duration = Duration::from_secs(3600);

fn assets_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("assets")
}

/// Reads `path` (refusing anything over the largest asset limit, the media one, before loading
/// it) and stores it; the per-kind limit is enforced after sniffing.
fn save_from_path(dir: &Path, path: &Path) -> Result<AssetInfo, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a supported file".into());
    }
    if meta.len() > MAX_ASSET_BYTES as u64 {
        return Err(format!("asset is {} bytes (max {MAX_ASSET_BYTES})", meta.len()));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    assets::save_sniffed(dir, &bytes).map_err(|e| e.to_string())
}

/// Stores an image, PDF or media file sent as the raw request body; the type is sniffed from the content
/// (the optional `x-asset-kind-hint` header is advisory only and ignored).
#[tauri::command]
pub fn save_asset(state: State<'_, AppState>, request: Request<'_>) -> Result<AssetInfo, String> {
    let Some(bytes) = body_bytes(request.body()) else {
        return Err("expected raw bytes".into());
    };
    assets::save_sniffed(&assets_dir(&state), &bytes).map_err(|e| e.to_string())
}

/// Stores a file the user picked or dropped, reading it in Rust so the bytes cross no IPC.
#[tauri::command]
/// On Android the picker hands over a `content://` URI, materialised first (off the main thread).
pub async fn save_asset_from_path(app: AppHandle, path: String) -> Result<AssetInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let path = materialize(&app, &state.data_dir, &path)?;
        save_from_path(&assets_dir(&state), &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn asset_info(state: State<'_, AppState>, id: String) -> Result<Option<AssetInfo>, String> {
    Ok(assets::asset_info(&assets_dir(&state), &id))
}

#[tauri::command]
pub fn delete_asset(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    Ok(assets::delete_asset(&assets_dir(&state), &id))
}

/// The stored file's bytes (for embedding in SVG exports).
#[tauri::command]
pub fn read_asset(state: State<'_, AppState>, id: String) -> Result<Response, String> {
    let path = assets::asset_path(&assets_dir(&state), &id).ok_or("asset not found")?;
    Ok(Response::new(fs::read(path).map_err(|e| e.to_string())?))
}

/// Removes every asset no element (live or in the trash) references; returns how many.
#[tauri::command]
pub fn gc_assets(state: State<'_, AppState>) -> Result<usize, String> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    collect_garbage(&storage, &state.recordings, &assets_dir(&state), GC_GRACE)
}

/// Removes the assets neither an element nor an unfinished recording's manifest names. A manifest that
/// cannot be read skips the whole collection: its segments cannot be told apart from garbage.
fn collect_garbage(storage: &Storage, recordings: &RecordingDir, dir: &Path, grace: Duration) -> Result<usize, String> {
    let mut referenced = storage.referenced_asset_ids().map_err(|e| e.to_string())?;
    referenced.extend(recordings.referenced_asset_ids().map_err(|e| e.to_string())?);
    Ok(assets::gc_unreferenced(dir, &referenced, grace))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_a_picked_file_and_rejects_others() {
        let root = std::env::temp_dir().join(format!("mate-asset-cmd-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let png = root.join("a.png");
        fs::write(&png, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]).unwrap();
        let txt = root.join("a.txt");
        fs::write(&txt, b"hello").unwrap();
        let dir = root.join("assets");
        let info = save_from_path(&dir, &png).unwrap();
        assert_eq!(info.mime, "image/png");
        assert!(save_from_path(&dir, &txt).is_err());
        assert!(save_from_path(&dir, &root).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// A minimal WebM (EBML) header.
    const WEBM: &[u8] = b"\x1A\x45\xDF\xA3\x9F\x42\x86\x81";

    fn gc_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mate-gc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// Makes `path` look older than the GC grace.
    fn age(path: &Path) {
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 3600);
        fs::File::options().write(true).open(path).unwrap().set_modified(old).unwrap();
    }

    #[test]
    fn gc_keeps_segments_named_by_an_unfinished_recording() {
        let root = gc_root("manifest");
        let dir = root.join("assets");
        let recordings = RecordingDir::new(root.join("recordings"));
        let storage = Storage::open_in_memory().unwrap();
        let rec_id = mate_core::model::new_id();
        recordings.begin(&rec_id, &serde_json::json!({"recId": rec_id, "segments": []})).unwrap();
        recordings.append(&rec_id, 0, WEBM).unwrap();
        let seg = recordings.finish_segment(&rec_id, 0, &dir).unwrap().unwrap();
        recordings
            .save_manifest(&rec_id, &serde_json::json!({"recId": rec_id, "segments": [{"assetId": seg.id, "durationMs": 1000}]}))
            .unwrap();
        age(&seg.path);
        assert_eq!(collect_garbage(&storage, &recordings, &dir, GC_GRACE).unwrap(), 0);
        assert!(assets::asset_path(&dir, &seg.id).is_some(), "a segment named by a manifest is kept");
        recordings.close(&rec_id).unwrap();
        assert_eq!(collect_garbage(&storage, &recordings, &dir, GC_GRACE).unwrap(), 1);
        assert!(assets::asset_path(&dir, &seg.id).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_is_skipped_when_a_manifest_cannot_be_read() {
        let root = gc_root("unreadable");
        let dir = root.join("assets");
        let recordings = RecordingDir::new(root.join("recordings"));
        let storage = Storage::open_in_memory().unwrap();
        let orphan = assets::save_sniffed(&dir, WEBM).unwrap();
        age(&orphan.path);
        let broken = root.join("recordings").join(mate_core::model::new_id());
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("manifest.json"), b"{ not json").unwrap();
        assert!(collect_garbage(&storage, &recordings, &dir, GC_GRACE).is_err());
        assert!(assets::asset_path(&dir, &orphan.id).is_some(), "nothing is collected");
        let _ = fs::remove_dir_all(&root);
    }
}
