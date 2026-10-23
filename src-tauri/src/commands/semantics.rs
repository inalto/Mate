//! Page summaries, title suggestions, related pages and the page graph.
//!
//! Summaries and titles call the configured AI provider with the page's recognised text only
//! (never ink), and only when `aiConsent` is on and a key is stored; otherwise they fail with
//! the readable [`AiError::Disabled`] message. Related pages and the graph are local.

use mate_core::ai::keystore::KeyStore;
use mate_core::ai::provider::{AiError, Provider};
use mate_core::ai::{is_known_provider, provider_for};
use mate_core::semantics::related::{self, PageGraph, RelatedPage};
use mate_core::semantics::summary::{self, Task};
use mate_core::settings::Settings;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

type Res<T> = Result<T, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SummaryResult {
    pub summary: String,
    pub cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TitleResult {
    pub title: String,
    pub cached: bool,
}

/// The provider for the current settings, or [`AiError::Disabled`] without consent or a key.
pub fn gated_provider(settings: &Settings, keys: &dyn KeyStore) -> Result<Box<dyn Provider>, AiError> {
    if settings.ai_consent != Some(true) {
        return Err(AiError::Disabled);
    }
    let provider = if is_known_provider(&settings.ai_provider) { settings.ai_provider.as_str() } else { "anthropic" };
    let key = keys
        .get(provider)
        .map_err(|_| AiError::Disabled)?
        .filter(|k| !k.trim().is_empty())
        .ok_or(AiError::Disabled)?;
    Ok(provider_for(provider, &settings.ai_model, key))
}

async fn generate(app: AppHandle, page_id: String, task: Task) -> Res<summary::Generated> {
    // Keychain access can block on an OS prompt, so the gate runs off the async runtime too.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
        // Gate first: with AI off nothing is read, cached or sent.
        let provider = gated_provider(&settings, state.keys.as_ref()).map_err(|e| e.to_string())?;
        summary::generate_for_page(&state.storage, provider.as_ref(), &page_id, task)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn summarize_page(app: AppHandle, page_id: String) -> Res<SummaryResult> {
    let g = generate(app, page_id, Task::Summary).await?;
    Ok(SummaryResult { summary: g.text, cached: g.cached })
}

#[tauri::command]
pub async fn suggest_title(app: AppHandle, page_id: String) -> Res<TitleResult> {
    let g = generate(app, page_id, Task::Title).await?;
    Ok(TitleResult { title: g.text, cached: g.cached })
}

#[tauri::command]
pub fn related_pages(state: State<'_, AppState>, page_id: String, limit: Option<usize>) -> Res<Vec<RelatedPage>> {
    // Read the documents under the lock; the TF-IDF work runs after it is released.
    let docs = state.storage.lock().map_err(|e| e.to_string())?.page_documents().map_err(|e| e.to_string())?;
    Ok(related::related_pages(&docs, &page_id, limit.unwrap_or(8)))
}

#[tauri::command]
pub fn page_graph(state: State<'_, AppState>, min_score: Option<f64>) -> Res<PageGraph> {
    let docs = state.storage.lock().map_err(|e| e.to_string())?.page_documents().map_err(|e| e.to_string())?;
    Ok(related::page_graph(&docs, min_score.unwrap_or(0.2)))
}

#[cfg(test)]
mod tests {
    use mate_core::ai::keystore::MemoryStore;

    use super::*;

    fn settings(consent: Option<bool>) -> Settings {
        Settings { ai_consent: consent, ..Settings::default() }
    }

    #[test]
    fn gate_needs_consent_and_a_key() {
        let keys = MemoryStore::default();
        for consent in [None, Some(false), Some(true)] {
            assert!(matches!(gated_provider(&settings(consent), &keys), Err(AiError::Disabled)));
        }
        keys.set("anthropic", "sk-test").unwrap();
        assert!(matches!(gated_provider(&settings(Some(false)), &keys), Err(AiError::Disabled)));
        assert!(gated_provider(&settings(Some(true)), &keys).is_ok());
        keys.set("anthropic", "  ").unwrap();
        assert!(matches!(gated_provider(&settings(Some(true)), &keys), Err(AiError::Disabled)));
    }
}
