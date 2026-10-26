use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::commands::lifecycle::CloseGates;
use crate::commands::recognize::{PageGates, ProviderCache};
use mate_core::ai::keystore::KeyStore;
#[cfg(desktop)]
use mate_core::ai::keystore::KeyringStore;
#[cfg(mobile)]
use mate_core::ai::keystore::FileKeyStore;
use mate_core::settings::Settings;
use mate_core::storage::Storage;
use tauri::Manager;

/// Shared application state: the SQLite store, the settings and the data directory.
pub struct AppState {
    pub storage: Mutex<Storage>,
    pub settings: Mutex<Settings>,
    pub data_dir: PathBuf,
    /// Window-close attempt state machines, one per window label.
    pub close_attempt: CloseGates,
    /// API keys (OS keychain on desktop, a file in the app sandbox on mobile); never exposed to
    /// the frontend.
    pub keys: Arc<dyn KeyStore>,
    /// Per-page limit on concurrent AI checks.
    pub recognize_gates: PageGates,
    /// The current AI provider, reused across checks (built off the async runtime).
    pub providers: Arc<ProviderCache>,
}

impl AppState {
    pub fn init(app: &tauri::AppHandle) -> Result<AppState, String> {
        // `MATE_DATA_DIR` points a dev build at a throwaway profile (screenshots, tests, demos).
        let data_dir = match std::env::var_os("MATE_DATA_DIR").filter(|v| !v.is_empty()) {
            Some(dir) => std::path::PathBuf::from(dir),
            None => app.path().app_data_dir().map_err(|e| e.to_string())?,
        };
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        eprintln!("mate: data dir = {}", data_dir.display());
        let storage = Storage::open(&data_dir.join("mate.db")).map_err(|e| e.to_string())?;
        let settings_path = data_dir.join("settings.json");
        let settings = Settings::load(&settings_path);
        if !settings_path.exists() {
            settings.save(&settings_path).map_err(|e| e.to_string())?;
        }
        #[cfg(desktop)]
        let keys: Arc<dyn KeyStore> = Arc::new(KeyringStore);
        #[cfg(mobile)]
        let keys: Arc<dyn KeyStore> = Arc::new(FileKeyStore::new(data_dir.join("keys.json")));
        Ok(AppState {
            storage: Mutex::new(storage),
            settings: Mutex::new(settings),
            data_dir,
            close_attempt: CloseGates::default(),
            keys,
            recognize_gates: PageGates::default(),
            providers: Arc::new(ProviderCache::default()),
        })
    }
}
