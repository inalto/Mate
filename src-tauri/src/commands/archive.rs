use std::fs;

use mate_core::archive::{ImportReport, MAX_ARCHIVE_BYTES, export_unit, import_archive};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::export::{ask_save_path, export_filename, write_atomically};
use crate::state::AppState;

/// Exports a unit (book) and the assets its elements reference to a `.mate` file chosen in a
/// save dialog. `None` if cancelled.
#[tauri::command]
pub async fn export_unit_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    unit_id: String,
) -> Result<Option<String>, String> {
    let (bytes, title) = {
        let storage = state.storage.lock().map_err(|e| e.to_string())?;
        let title = storage
            .list_tree()
            .map_err(|e| e.to_string())?
            .units
            .into_iter()
            .find(|u| u.id == unit_id)
            .map(|u| u.title)
            .unwrap_or_default();
        (
            export_unit(&storage, &unit_id, &state.data_dir.join("assets"))
                .map_err(|e| e.to_string())?,
            title,
        )
    };
    let Some(path) = ask_save_path(app, export_filename(&title, "mate")).await? else {
        return Ok(None);
    };
    write_atomically(&path, &bytes)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Imports a `.mate` file chosen in an open dialog as a new book (its assets go to the asset
/// store under new ids). `None` if cancelled.
#[tauri::command]
pub async fn import_unit_archive(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ImportReport>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Mate archive", &["mate"])
            .blocking_pick_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(path) = picked else {
        return Ok(None);
    };
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_ARCHIVE_BYTES as u64 {
        return Err("archive is larger than 512 MiB".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    import_archive(&mut storage, &bytes, &state.data_dir.join("assets"))
        .map(Some)
        .map_err(|e| e.to_string())
}
