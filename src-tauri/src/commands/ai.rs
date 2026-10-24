//! AI key, status and provider commands. The key goes into the keychain and never comes back out
//! over IPC: no command returns it, and it is never logged or written to `settings.json`.

use std::sync::Arc;

use mate_core::ai::catalog::{Group, Vision, catalog, effective_base_url, spec, spec_or_default};
use mate_core::ai::is_known_provider;
use mate_core::ai::keystore::KeyStore;
use mate_core::ai::provider::{AiError, Provider, TextRequest};
use mate_core::settings::Settings;
use serde::Serialize;
use tauri::State;

use crate::commands::recognize::effective_model;
use crate::state::AppState;

/// What the UI may know about the AI setup. Deliberately has no key field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// A key is stored (cloud), always (local), or an address is set (custom).
    pub configured: bool,
    pub provider: String,
    pub model: String,
    pub consent: bool,
    pub needs_key: bool,
    pub vision: Vision,
    /// The effective address (the setting, or the catalog default).
    pub base_url: String,
}

/// One catalog entry as the UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub group: Group,
    pub needs_key: bool,
    pub editable_base_url: bool,
    pub default_base_url: &'static str,
    pub default_model: &'static str,
    pub vision: Vision,
    pub can_list_models: bool,
    pub key_url: &'static str,
    pub cost: &'static str,
    pub privacy: &'static str,
}

pub fn providers() -> Vec<AiProviderInfo> {
    catalog()
        .iter()
        .map(|s| AiProviderInfo {
            id: s.id,
            label: s.label,
            group: s.group(),
            needs_key: s.needs_key,
            editable_base_url: s.editable_base_url,
            default_base_url: s.base_url,
            default_model: s.default_model,
            vision: s.vision,
            can_list_models: s.models_path.is_some(),
            key_url: s.key_url,
            cost: s.cost,
            privacy: s.privacy,
        })
        .collect()
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
    let s = spec_or_default(&settings.ai_provider);
    let base_url = effective_base_url(s.id, &settings.ai_base_url);
    let configured = if s.needs_key {
        has_key(store, s.id)?
    } else {
        s.local || !base_url.is_empty()
    };
    Ok(AiStatus {
        configured,
        provider: s.id.to_string(),
        model: effective_model(s.id, &settings.ai_model),
        consent: settings.ai_consent == Some(true),
        needs_key: s.needs_key,
        vision: s.vision,
        base_url,
    })
}

/// Succeeds when a non-empty key is stored for `provider` (no network).
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

/// The provider catalog, so the UI never keeps its own copy.
#[tauri::command]
pub fn list_ai_providers() -> Vec<AiProviderInfo> {
    providers()
}

/// Models offered by the current provider. Sends the key to its own service and nothing else (no
/// user content), so it is allowed without AI consent.
#[tauri::command]
pub async fn list_ai_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    let cache = state.providers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        models(store.as_ref(), &settings, |p, m, k, b| cache.get(p, m, k, b.unwrap_or("")))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Fetch models" for the current settings, through `make`.
pub fn models(
    store: &dyn KeyStore,
    settings: &Settings,
    make: impl FnOnce(&str, &str, &str, Option<&str>) -> Arc<dyn Provider>,
) -> Result<Vec<String>, String> {
    let s = spec_or_default(&settings.ai_provider);
    if s.models_path.is_none() {
        return Err(format!("{} cannot list its models. Type the model name.", s.label));
    }
    let key = store.get(s.id)?.filter(|k| !k.trim().is_empty()).unwrap_or_default();
    if s.needs_key && key.is_empty() {
        return Err("Save an API key first.".into());
    }
    let base_url = effective_base_url(s.id, &settings.ai_base_url);
    if base_url.is_empty() {
        return Err("Enter the service address first.".into());
    }
    let model = effective_model(s.id, &settings.ai_model);
    let mut list = make(s.id, &model, &key, Some(&base_url)).list_models().map_err(|e| e.to_string())?;
    list.sort();
    list.dedup();
    Ok(list)
}

/// Cloud services: with AI consent on, a minimal real request (a few output tokens) checks the key
/// with the service; without consent it only checks that a key is stored, so nothing leaves the
/// device. Local programs: a model-list request checks that they are running (no user content,
/// so consent is not needed).
#[tauri::command]
pub async fn test_ai_key(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    let cache = state.providers.clone();
    // The provider (a blocking HTTP client) is built and used only on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || {
        check_key(store.as_ref(), &settings, &provider, |p, m, k, b| cache.get(p, m, k, b.unwrap_or("")))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Test": the stored-key check, then (with consent) one tiny request through `make`; for local
/// providers, a reachability check.
pub fn check_key(
    store: &dyn KeyStore,
    settings: &Settings,
    provider: &str,
    make: impl FnOnce(&str, &str, &str, Option<&str>) -> Arc<dyn Provider>,
) -> Result<(), String> {
    let s = spec(provider).ok_or_else(|| format!("unknown AI provider \"{provider}\""))?;
    // The address and model settings belong to the selected provider only.
    let current = settings.ai_provider == provider;
    let base_url = effective_base_url(provider, if current { &settings.ai_base_url } else { "" });
    let model = effective_model(provider, if current { &settings.ai_model } else { "" });
    if s.local {
        return make(provider, &model, "", Some(&base_url))
            .list_models()
            .map(|_| ())
            .map_err(|_| format!("Could not reach {} at {base_url}. Is it running?", s.label));
    }
    if s.needs_key {
        test_key(store, provider)?;
    } else if base_url.is_empty() {
        return Err("Enter the service address first.".into());
    }
    if settings.ai_consent != Some(true) {
        return Ok(());
    }
    let key = store.get(provider)?.unwrap_or_default();
    ping(make(provider, &model, &key, Some(&base_url)).as_ref())
}

/// A reply cut off by the tiny token budget still proves the key works.
pub fn ping(p: &dyn Provider) -> Result<(), String> {
    let req = TextRequest { system: String::new(), user: "Reply with OK.".into(), max_tokens: 16, json_schema: None };
    match p.complete(&req) {
        Ok(_) | Err(AiError::Truncated) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::catalog::{Group, Vision};
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
        assert_eq!(keys, ["baseUrl", "configured", "consent", "model", "needsKey", "provider", "vision"]);
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
        assert!(st.configured && !st.consent && st.needs_key);
        assert_eq!((st.provider.as_str(), st.model.as_str()), ("openai", "gpt-5"));
        assert_eq!((st.vision, st.base_url.as_str()), (Vision::Yes, "https://api.openai.com"));

        settings.ai_model = "gpt-5-mini".into();
        settings.ai_consent = Some(true);
        settings.ai_provider = "anthropic".into();
        let st = status(&store, &settings).unwrap();
        assert!(!st.configured && st.consent);
        assert_eq!((st.provider.as_str(), st.model.as_str()), ("anthropic", "gpt-5-mini"));
    }

    #[test]
    fn ping_accepts_cut_off_replies_and_reports_auth() {
        use mate_core::ai::mock::MockProvider;
        let ok = MockProvider::new(vec![]).with_text(vec![Err(AiError::Truncated)]);
        assert!(ping(&ok).is_ok());
        let garbled = MockProvider::new(vec![]).with_text(vec![Err(AiError::InvalidResponse("x".into()))]);
        assert!(ping(&garbled).is_err());
        let bad = MockProvider::new(vec![]).with_text(vec![Err(AiError::Auth)]);
        assert_eq!(ping(&bad).unwrap_err(), AiError::Auth.to_string());
    }

    #[test]
    fn test_key_pings_every_provider_only_with_consent() {
        use mate_core::ai::mock::MockProvider;
        let store = MemoryStore::default();
        store.set("anthropic", "k").unwrap();
        store.set("openai", "bogus").unwrap();
        let rejecting = || -> Arc<dyn Provider> { Arc::new(MockProvider::new(vec![]).with_text(vec![Err(AiError::Auth)])) };
        let mut settings = Settings::default();
        // No consent: nothing is sent, a stored key is enough.
        for p in ["anthropic", "openai"] {
            let mut called = false;
            let r = check_key(&store, &settings, p, |_, _, _, _| {
                called = true;
                rejecting()
            });
            assert!(r.is_ok());
            assert!(!called, "{p} must not be contacted without consent");
        }
        // Consent: both providers are asked, so a bogus key is reported.
        settings.ai_consent = Some(true);
        for p in ["anthropic", "openai"] {
            let mut asked = None;
            let r = check_key(&store, &settings, p, |prov, _, key, _| {
                asked = Some((prov.to_string(), key.to_string()));
                rejecting()
            });
            assert_eq!(r.unwrap_err(), AiError::Auth.to_string());
            assert_eq!(asked.unwrap(), (p.to_string(), store.get(p).unwrap().unwrap()));
        }
    }

    #[test]
    fn provider_list_mirrors_the_catalog() {
        let list = providers();
        assert_eq!(list.len(), mate_core::ai::catalog::catalog().len());
        let ollama = list.iter().find(|p| p.id == "ollama").unwrap();
        assert_eq!(ollama.group, Group::Local);
        assert!(!ollama.needs_key && ollama.editable_base_url && ollama.can_list_models);
        assert_eq!(ollama.default_base_url, "http://localhost:11434");
        let zai = list.iter().find(|p| p.id == "zai").unwrap();
        assert!(!zai.can_list_models);
        let json = serde_json::to_value(&list).unwrap();
        let first = json[0].as_object().unwrap();
        let mut keys: Vec<&str> = first.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "canListModels", "cost", "defaultBaseUrl", "defaultModel", "editableBaseUrl", "group", "id", "keyUrl",
                "label", "needsKey", "privacy", "vision"
            ]
        );
        let deepseek = json.as_array().unwrap().iter().find(|p| p["id"] == "deepseek").unwrap();
        assert_eq!(deepseek["vision"], "no");
        assert_eq!(json.as_array().unwrap().iter().find(|p| p["id"] == "custom").unwrap()["group"], "custom");
        assert_eq!(json.as_array().unwrap().iter().find(|p| p["id"] == "openrouter").unwrap()["vision"], "dependsOnModel");
    }

    #[test]
    fn local_and_custom_status() {
        let store = MemoryStore::default();
        let mut settings = Settings { ai_provider: "ollama".into(), ..Settings::default() };
        let st = status(&store, &settings).unwrap();
        assert!(st.configured && !st.needs_key);
        assert_eq!(st.base_url, "http://localhost:11434");
        assert_eq!(st.model, "qwen3-vl:8b");
        assert_eq!(st.vision, Vision::DependsOnModel);
        settings.ai_base_url = "http://gpu-box:11434/".into();
        assert_eq!(status(&store, &settings).unwrap().base_url, "http://gpu-box:11434");

        settings.ai_provider = "custom".into();
        settings.ai_base_url = String::new();
        assert!(!status(&store, &settings).unwrap().configured, "custom needs an address");
        settings.ai_base_url = "https://llm.example.org".into();
        let st = status(&store, &settings).unwrap();
        assert!(st.configured && !st.needs_key);
        assert_eq!(serde_json::to_value(&st).unwrap()["vision"], "dependsOnModel");

        // A key for a keyless provider may still be saved (custom endpoints sometimes want one).
        set_key(&store, "custom", "k").unwrap();
        assert!(set_key(&store, "mock", "k").is_err());
    }

    #[test]
    fn local_test_is_a_reachability_check_without_consent() {
        use mate_core::ai::mock::MockProvider;
        let store = MemoryStore::default();
        let settings = Settings { ai_provider: "ollama".into(), ai_base_url: "http://box:1".into(), ..Settings::default() };
        let mut asked = None;
        let r = check_key(&store, &settings, "ollama", |p, _, key, base| {
            asked = Some((p.to_string(), key.to_string(), base.map(str::to_string)));
            Arc::new(MockProvider::new(vec![]).with_models(Ok(vec!["m".into()])))
        });
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(asked.unwrap(), ("ollama".into(), String::new(), Some("http://box:1".into())));
        let r = check_key(&store, &settings, "ollama", |_, _, _, _| {
            Arc::new(MockProvider::new(vec![]).with_models(Err(AiError::Network("no connection".into()))))
        });
        let e = r.unwrap_err();
        assert!(e.contains("Ollama") && e.contains("http://box:1"), "{e}");
        // No text is ever sent for a reachability check.
        let mock = Arc::new(MockProvider::new(vec![]).with_models(Ok(vec![])));
        let m2 = mock.clone();
        check_key(&store, &settings, "lmstudio", move |_, _, _, _| m2).unwrap();
        assert!(mock.text_requests().is_empty());
    }

    #[test]
    fn custom_test_needs_an_address_and_pings_with_consent() {
        use mate_core::ai::mock::MockProvider;
        let store = MemoryStore::default();
        let mut settings = Settings { ai_provider: "custom".into(), ..Settings::default() };
        let r = check_key(&store, &settings, "custom", |_, _, _, _| unreachable!());
        assert!(r.is_err());
        settings.ai_base_url = "https://llm.example.org".into();
        assert!(check_key(&store, &settings, "custom", |_, _, _, _| unreachable!()).is_ok());
        settings.ai_consent = Some(true);
        let r = check_key(&store, &settings, "custom", |_, _, _, base| {
            assert_eq!(base, Some("https://llm.example.org"));
            Arc::new(MockProvider::new(vec![]).with_text(vec![Ok("OK".into())]))
        });
        assert!(r.is_ok());
    }

    #[test]
    fn model_listing() {
        use mate_core::ai::mock::MockProvider;
        let store = MemoryStore::default();
        let mut settings = Settings { ai_provider: "openai".into(), ..Settings::default() };
        // A cloud service needs its key first; nothing is built without it.
        assert!(models(&store, &settings, |_, _, _, _| unreachable!()).is_err());
        store.set("openai", "sk-1").unwrap();
        let out = models(&store, &settings, |p, _, key, _| {
            assert_eq!((p, key), ("openai", "sk-1"));
            Arc::new(MockProvider::new(vec![]).with_models(Ok(vec!["b".into(), "a".into(), "b".into()])))
        })
        .unwrap();
        assert_eq!(out, ["a", "b"]);
        let e = models(&store, &settings, |_, _, _, _| {
            Arc::new(MockProvider::new(vec![]).with_models(Err(AiError::Auth)))
        })
        .unwrap_err();
        assert_eq!(e, AiError::Auth.to_string());
        // A provider with no listing endpoint says so without a request.
        settings.ai_provider = "zai".into();
        store.set("zai", "k").unwrap();
        assert!(models(&store, &settings, |_, _, _, _| unreachable!()).is_err());
        // Local providers list without a key.
        settings.ai_provider = "ollama".into();
        let out = models(&store, &settings, |_, _, key, _| {
            assert_eq!(key, "");
            Arc::new(MockProvider::new(vec![]).with_models(Ok(vec!["qwen3-vl:8b".into()])))
        })
        .unwrap();
        assert_eq!(out, ["qwen3-vl:8b"]);
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
