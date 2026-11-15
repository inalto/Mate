//! Recall answers from the cover study run and the statistics read back from them.

use mate_core::model::now_iso;
use mate_core::storage::{RecallAnswer, RecallPageStats, RecallUnitStats};
use tauri::State;

use crate::state::AppState;

type Res<T> = Result<T, String>;

#[tauri::command]
pub fn record_recall(state: State<'_, AppState>, answer: RecallAnswer) -> Res<()> {
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.record_recall(&answer).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recall_page_stats(state: State<'_, AppState>, page_id: String) -> Res<RecallPageStats> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.recall_page(&page_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recall_unit_stats(state: State<'_, AppState>, unit_id: String) -> Res<RecallUnitStats> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.recall_unit(&unit_id, &now_iso()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recall_element_history(state: State<'_, AppState>, element_id: String, last: usize) -> Res<Vec<bool>> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.recall_element(&element_id, last).map_err(|e| e.to_string())
}
