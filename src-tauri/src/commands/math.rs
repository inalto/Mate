//! Wolfram|Alpha commands. The AppID goes into the keychain (account `wolframalpha`) and never
//! comes back out over IPC: no command returns it, and it is never logged.

use std::sync::Arc;

use mate_core::ai::keystore::KeyStore;
use mate_core::math::wolfram::{ENDPOINT, OFF, short_answer};
use mate_core::settings::Settings;
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// Keychain account for the AppID.
pub const ACCOUNT: &str = "wolframalpha";

/// What the UI may know. Deliberately has no AppID field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WolframStatus {
    pub configured: bool,
    pub consent: bool,
}

pub fn set_appid(store: &dyn KeyStore, appid: &str) -> Result<(), String> {
    let appid = appid.trim();
    if appid.is_empty() {
        return Err("Enter an AppID first.".into());
    }
    store.set(ACCOUNT, appid)
}

pub fn clear_appid(store: &dyn KeyStore) -> Result<(), String> {
    store.delete(ACCOUNT)
}

fn stored_appid(store: &dyn KeyStore) -> Result<Option<String>, String> {
    Ok(store.get(ACCOUNT)?.filter(|k| !k.trim().is_empty()))
}

pub fn status(store: &dyn KeyStore, settings: &Settings) -> Result<WolframStatus, String> {
    Ok(WolframStatus { configured: stored_appid(store)?.is_some(), consent: settings.wolfram_consent })
}

/// "Test": asks `2+2` (no user content, so consent is not needed).
pub fn test_appid(store: &dyn KeyStore, endpoint: &str) -> Result<(), String> {
    let appid = stored_appid(store)?.ok_or("Save an AppID first.")?;
    short_answer(endpoint, &appid, "2+2").map(|_| ())
}

/// The answer to a typed query; refused unless the user turned Wolfram|Alpha on.
pub fn answer(store: &dyn KeyStore, settings: &Settings, endpoint: &str, query: &str) -> Result<String, String> {
    if !settings.wolfram_consent {
        return Err(OFF.into());
    }
    let appid = stored_appid(store)?.ok_or("Save an AppID in Settings first.")?;
    short_answer(endpoint, &appid, query)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_wolfram_appid(state: State<'_, AppState>, appid: String) -> Result<(), String> {
    let store: Arc<dyn KeyStore> = state.keys.clone();
    blocking(move || set_appid(store.as_ref(), &appid)).await
}

#[tauri::command]
pub async fn clear_wolfram_appid(state: State<'_, AppState>) -> Result<(), String> {
    let store: Arc<dyn KeyStore> = state.keys.clone();
    blocking(move || clear_appid(store.as_ref())).await
}

#[tauri::command]
pub async fn wolfram_status(state: State<'_, AppState>) -> Result<WolframStatus, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    blocking(move || status(store.as_ref(), &settings)).await
}

#[tauri::command]
pub async fn test_wolfram_appid(state: State<'_, AppState>) -> Result<(), String> {
    let store: Arc<dyn KeyStore> = state.keys.clone();
    blocking(move || test_appid(store.as_ref(), ENDPOINT)).await
}

#[tauri::command]
pub async fn wolfram_short_answer(state: State<'_, AppState>, query: String) -> Result<String, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    blocking(move || answer(store.as_ref(), &settings, ENDPOINT, &query)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;

    #[test]
    fn appid_never_leaves_rust() {
        let store = MemoryStore::default();
        let settings = Settings::default();
        assert!(!status(&store, &settings).unwrap().configured);
        assert!(set_appid(&store, "   ").is_err());
        set_appid(&store, "  SECRET-ID ").unwrap();
        assert_eq!(store.get(ACCOUNT).unwrap().as_deref(), Some("SECRET-ID"));
        let st = status(&store, &settings).unwrap();
        assert!(st.configured && !st.consent);
        let json = serde_json::to_value(&st).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["configured", "consent"]);
        assert!(!serde_json::to_string(&settings).unwrap().contains("SECRET"));
        clear_appid(&store).unwrap();
        assert!(!status(&store, &settings).unwrap().configured);
    }

    #[test]
    fn query_is_refused_without_consent_and_without_contacting_anything() {
        let store = MemoryStore::default();
        store.set(ACCOUNT, "id").unwrap();
        let settings = Settings::default();
        // The endpoint is unreachable: a refusal must come before any request.
        assert_eq!(answer(&store, &settings, "http://127.0.0.1:1/", "2+2").unwrap_err(), OFF);
    }

    #[test]
    fn query_needs_a_saved_appid() {
        let store = MemoryStore::default();
        let settings = Settings { wolfram_consent: true, ..Settings::default() };
        assert!(answer(&store, &settings, "http://127.0.0.1:1/", "2+2").unwrap_err().contains("AppID"));
        assert!(test_appid(&store, "http://127.0.0.1:1/").unwrap_err().contains("AppID"));
    }
}
