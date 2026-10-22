use std::fs;
use std::path::{Path, PathBuf};

use mate_core::assets::{self, AssetInfo, MAX_PDF_BYTES};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::state::AppState;

fn assets_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("assets")
}

/// Reads `path` (refusing anything over the PDF limit before loading it) and stores it.
fn save_from_path(dir: &Path, path: &Path) -> Result<AssetInfo, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() as usize > MAX_PDF_BYTES {
        return Err("not a supported file".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    assets::save_sniffed(dir, &bytes).map_err(|e| e.to_string())
}

/// Stores an image or PDF sent as the raw request body; the type is sniffed from the content
/// (the optional `x-asset-kind-hint` header is advisory only and ignored).
#[tauri::command]
pub fn save_asset(state: State<'_, AppState>, request: Request<'_>) -> Result<AssetInfo, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    assets::save_sniffed(&assets_dir(&state), bytes).map_err(|e| e.to_string())
}

/// Stores a file the user picked or dropped, reading it in Rust so the bytes cross no IPC.
#[tauri::command]
pub fn save_asset_from_path(state: State<'_, AppState>, path: String) -> Result<AssetInfo, String> {
    save_from_path(&assets_dir(&state), Path::new(&path))
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
    let referenced = state
        .storage
        .lock()
        .map_err(|e| e.to_string())?
        .referenced_asset_ids()
        .map_err(|e| e.to_string())?;
    Ok(assets::gc_unreferenced(&assets_dir(&state), &referenced))
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
}
