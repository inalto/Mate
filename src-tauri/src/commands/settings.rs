use mate_core::settings::Settings;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    let mut current = state.settings.lock().map_err(|e| e.to_string())?;
    settings
        .save(&state.data_dir.join("settings.json"))
        .map_err(|e| e.to_string())?;
    *current = settings;
    Ok(())
}
