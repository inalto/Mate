use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::commands::lifecycle::CloseGate;
use mate_core::settings::Settings;
use mate_core::storage::Storage;
use tauri::Manager;

/// Shared application state: the SQLite store, the settings and the data directory.
pub struct AppState {
    pub storage: Mutex<Storage>,
    pub settings: Mutex<Settings>,
    pub data_dir: PathBuf,
    /// Window-close attempt state machine.
    pub close_attempt: Mutex<CloseGate>,
}

impl AppState {
    pub fn init(app: &tauri::AppHandle) -> Result<AppState, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        eprintln!("mate: data dir = {}", data_dir.display());
        let storage = Storage::open(&data_dir.join("mate.db")).map_err(|e| e.to_string())?;
        let settings_path = data_dir.join("settings.json");
        let settings = Settings::load(&settings_path);
        if !settings_path.exists() {
            settings.save(&settings_path).map_err(|e| e.to_string())?;
        }
        Ok(AppState {
            storage: Mutex::new(storage),
            settings: Mutex::new(settings),
            data_dir,
            close_attempt: Mutex::new(CloseGate::default()),
        })
    }
}
