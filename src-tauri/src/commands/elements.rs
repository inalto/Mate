use mate_core::model::Element;
use tauri::State;

use crate::state::AppState;

type Res<T> = Result<T, String>;

#[tauri::command]
pub fn load_elements(state: State<'_, AppState>, page_id: String) -> Res<Vec<Element>> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.load_elements(&page_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_elements(state: State<'_, AppState>, elements: Vec<Element>) -> Res<()> {
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.upsert_elements(&elements).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_elements(state: State<'_, AppState>, ids: Vec<String>) -> Res<()> {
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.delete_elements(&ids).map_err(|e| e.to_string())
}
