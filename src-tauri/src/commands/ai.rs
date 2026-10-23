//! AI key and status commands. The key goes into the keychain and never comes back out over IPC:
//! no command returns it, and it is never logged or written to `settings.json`.

use std::sync::Arc;

use mate_core::ai::keystore::KeyStore;
use mate_core::ai::{default_model, is_known_provider};
use mate_core::settings::Settings;
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// What the UI may know about the AI setup. Deliberately has no key field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub configured: bool,
    pub provider: String,
    pub model: String,
    pub consent: bool,
}

fn check_provider(provider: &str) -> Result<(), String> {
    if is_known_provider(provider) {
        Ok(())
    } else {
        Err(format!("unknown AI provider \"{provider}\""))
    }
}

fn has_key(store: &dyn KeyStore, provider: &str) -> Result<bool, String> {
    Ok(store.get(provider)?.is_some_and(|k| !k.trim().is_empty()))
}

pub fn set_key(store: &dyn KeyStore, provider: &str, key: &str) -> Result<(), String> {
    check_provider(provider)?;
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter an API key first.".into());
    }
    store.set(provider, key)
}

pub fn clear_key(store: &dyn KeyStore, provider: &str) -> Result<(), String> {
    check_provider(provider)?;
    store.delete(provider)
}

pub fn status(store: &dyn KeyStore, settings: &Settings) -> Result<AiStatus, String> {
    let provider = if is_known_provider(&settings.ai_provider) {
        settings.ai_provider.clone()
    } else {
        "anthropic".to_string()
    };
    let model = match settings.ai_model.trim() {
        "" => default_model(&provider).to_string(),
        m => m.to_string(),
    };
    Ok(AiStatus {
        configured: has_key(store, &provider)?,
        model,
        provider,
        consent: settings.ai_consent == Some(true),
    })
}

/// For now: succeeds when a non-empty key is stored. A later task makes this a real 1-token ping.
pub fn test_key(store: &dyn KeyStore, provider: &str) -> Result<(), String> {
    check_provider(provider)?;
    if has_key(store, provider)? {
        Ok(())
    } else {
        Err("No key is saved for this provider.".into())
    }
}

/// Runs a keychain operation off the async runtime (keychain calls can block on OS prompts).
async fn on_keychain<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&dyn KeyStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let store: Arc<dyn KeyStore> = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || f(store.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_ai_key(state: State<'_, AppState>, provider: String, key: String) -> Result<(), String> {
    on_keychain(&state, move |s| set_key(s, &provider, &key)).await
}

#[tauri::command]
pub async fn clear_ai_key(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    on_keychain(&state, move |s| clear_key(s, &provider)).await
}

#[tauri::command]
pub async fn get_ai_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    on_keychain(&state, move |s| status(s, &settings)).await
}

#[tauri::command]
pub async fn test_ai_key(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    on_keychain(&state, move |s| test_key(s, &provider)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;

    #[test]
    fn key_never_leaves_rust() {
        let store = MemoryStore::default();
        let settings = Settings::default();
        assert!(!status(&store, &settings).unwrap().configured);

        set_key(&store, "anthropic", "  sk-secret-123  ").unwrap();
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("sk-secret-123"));
        let st = status(&store, &settings).unwrap();
        assert!(st.configured);

        let json = serde_json::to_value(&st).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["configured", "consent", "model", "provider"]);
        let text = json.to_string();
        assert!(!text.contains("sk-secret"));
        // Settings never carry it either.
        assert!(!serde_json::to_string(&settings).unwrap().contains("sk-secret"));
    }

    #[test]
    fn status_reports_provider_model_and_consent() {
        let store = MemoryStore::default();
        store.set("openai", "k").unwrap();
        let mut settings = Settings { ai_provider: "openai".into(), ..Settings::default() };
        let st = status(&store, &settings).unwrap();
        assert_eq!(st, AiStatus { configured: true, provider: "openai".into(), model: "gpt-5".into(), consent: false });

        settings.ai_model = "gpt-5-mini".into();
        settings.ai_consent = Some(true);
        settings.ai_provider = "anthropic".into();
        let st = status(&store, &settings).unwrap();
        assert_eq!(st, AiStatus { configured: false, provider: "anthropic".into(), model: "gpt-5-mini".into(), consent: true });
    }

    #[test]
    fn set_rejects_empty_and_unknown_and_clear_removes() {
        let store = MemoryStore::default();
        assert!(set_key(&store, "anthropic", "   ").is_err());
        assert!(set_key(&store, "acme", "k").is_err());
        assert!(test_key(&store, "anthropic").is_err());
        set_key(&store, "anthropic", "k").unwrap();
        assert!(test_key(&store, "anthropic").is_ok());
        clear_key(&store, "anthropic").unwrap();
        assert!(test_key(&store, "anthropic").is_err());
        assert_eq!(store.get("anthropic").unwrap(), None);
    }
}
