//! Lecture recording: streams each audio segment to disk as it grows and lists what a crash left behind.

use mate_core::assets::AssetInfo;
use mate_core::recording::Unfinished;
use serde_json::Value;
use tauri::ipc::Request;
use tauri::State;

use super::ipc_body::body_bytes;
use crate::state::AppState;

#[tauri::command]
pub fn recording_begin(state: State<'_, AppState>, rec_id: String, manifest: Value) -> Result<(), String> {
    state.recordings.begin(&rec_id, &manifest).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_save_manifest(state: State<'_, AppState>, rec_id: String, manifest: Value) -> Result<(), String> {
    state.recordings.save_manifest(&rec_id, &manifest).map_err(|e| e.to_string())
}

/// Appends the raw request body to a segment (`x-rec-id`: the recording, `x-rec-index`: the segment).
#[tauri::command]
pub fn recording_append(state: State<'_, AppState>, request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    let rec_id = header("x-rec-id").ok_or("missing x-rec-id")?;
    let index: u32 = header("x-rec-index").and_then(|v| v.parse().ok()).ok_or("missing or invalid x-rec-index")?;
    let bytes = body_bytes(request.body()).ok_or("expected raw bytes")?;
    state.recordings.append(rec_id, index, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_finish_segment(
    state: State<'_, AppState>,
    rec_id: String,
    index: u32,
) -> Result<Option<AssetInfo>, String> {
    state.recordings.finish_segment(&rec_id, index, &state.data_dir.join("assets")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_close(state: State<'_, AppState>, rec_id: String) -> Result<(), String> {
    state.recordings.close(&rec_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_unfinished(state: State<'_, AppState>) -> Result<Vec<Unfinished>, String> {
    state.recordings.unfinished().map_err(|e| e.to_string())
}
