//! Tutor recognitions, their full-text search and learning events.

use mate_core::storage::{LearningEvent, Recognition, SearchHit, UpsertOutcome};
use tauri::State;

use crate::state::AppState;

type Res<T> = Result<T, String>;

#[tauri::command]
pub fn get_recognitions(state: State<'_, AppState>, page_id: String) -> Res<Vec<Recognition>> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.get_recognitions(&page_id).map_err(|e| e.to_string())
}

/// `"stale"` means the ink changed after capture (or a newer capture is stored): drop the result.
#[tauri::command]
pub fn upsert_recognition(state: State<'_, AppState>, rec: Recognition) -> Res<UpsertOutcome> {
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.upsert_recognition(&rec).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_user_override(
    state: State<'_, AppState>,
    page_id: String,
    stroke_group_id: String,
    correct: bool,
) -> Res<()> {
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage
        .set_user_override(&page_id, &stroke_group_id, correct)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_recognition(state: State<'_, AppState>, query: String, limit: usize) -> Res<Vec<SearchHit>> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.search_recognition(&query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_learning_event(state: State<'_, AppState>, ev: LearningEvent) -> Res<()> {
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.record_learning_event(&ev).map_err(|e| e.to_string())
}
