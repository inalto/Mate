use mate_core::model::Element;
use mate_core::storage::ElementTime;
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

#[tauri::command]
pub fn unit_element_times(
    state: State<'_, AppState>,
    unit_id: String,
    from: String,
    to: String,
) -> Res<Vec<ElementTime>> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.unit_element_times(&unit_id, &from, &to).map_err(|e| e.to_string())
}

/// Whether the unit has a live recording (decides if the export and share dialogs offer to
/// include recordings).
#[tauri::command]
pub fn unit_has_recordings(state: State<'_, AppState>, unit_id: String) -> Res<bool> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    storage.unit_has_recordings(&unit_id).map_err(|e| e.to_string())
}
