//! Page summaries, title suggestions, related pages and the page graph.
//!
//! Summaries and titles call the configured AI provider with the page's recognised text only
//! (never ink), and only when `aiConsent` is on and a key is stored; otherwise they fail with
//! the readable [`AiError::Disabled`] message. Related pages and the graph are local.

use mate_core::ai::keystore::KeyStore;
use mate_core::ai::provider::{AiError, Provider};
use mate_core::ai::provider_for;
use mate_core::semantics::related::{self, PageGraph, RelatedPage};
use mate_core::semantics::summary::{self, SummaryError, Task};
use mate_core::settings::Settings;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::recognize::{RecognizeError, connection};
use crate::state::AppState;

type Res<T> = Result<T, String>;
/// The error of an AI-backed command: `kind` lets the app block live checking after a rejected
/// key, a billing problem or an unknown model, exactly as a failed tutor check does.
pub type AiRes<T> = Result<T, RecognizeError>;

/// A summary failure as the app sees it.
pub fn summary_error(e: SummaryError) -> RecognizeError {
    match e {
        SummaryError::Ai(a) => a.into(),
        SummaryError::Other(message) => RecognizeError { kind: "internal", message },
    }
}

/// A non-AI failure (storage, a poisoned lock).
pub fn internal_error(e: impl ToString) -> RecognizeError {
    RecognizeError { kind: "internal", message: e.to_string() }
}

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

/// The provider for the current settings, or [`AiError::Disabled`] without consent or a needed
/// key or address.
pub fn gated_provider(settings: &Settings, keys: &dyn KeyStore) -> Result<Box<dyn Provider>, AiError> {
    if settings.ai_consent != Some(true) {
        return Err(AiError::Disabled);
    }
    let c = connection(settings, keys)?;
    Ok(provider_for(&c.provider, &c.model, c.key, Some(&c.base_url)))
}

async fn generate(app: AppHandle, page_id: String, task: Task) -> AiRes<summary::Generated> {
    // Keychain access can block on an OS prompt, so the gate runs off the async runtime too.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().map_err(internal_error)?.clone();
        // Gate first: with AI off nothing is read, cached or sent.
        let provider = gated_provider(&settings, state.keys.as_ref())?;
        summary::generate_for_page(&state.storage, provider.as_ref(), &page_id, task).map_err(summary_error)
    })
    .await
    .map_err(internal_error)?
}

#[tauri::command]
pub async fn summarize_page(app: AppHandle, page_id: String) -> AiRes<SummaryResult> {
    let g = generate(app, page_id, Task::Summary).await?;
    Ok(SummaryResult { summary: g.text, cached: g.cached })
}

#[tauri::command]
pub async fn suggest_title(app: AppHandle, page_id: String) -> AiRes<TitleResult> {
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
    fn summary_failures_keep_their_kind_for_the_block() {
        let kind = |e: AiError| summary_error(SummaryError::Ai(e)).kind;
        assert_eq!(kind(AiError::Auth), "auth");
        assert_eq!(kind(AiError::Billing), "billing");
        assert_eq!(kind(AiError::UnknownModel), "unknownModel");
        assert_eq!(kind(AiError::RateLimited), "rateLimited");
        // The gate itself fails with a typed error too (converted with `?` in the commands).
        let gated: Option<RecognizeError> =
            gated_provider(&settings(None), &MemoryStore::default()).err().map(RecognizeError::from);
        assert_eq!(gated.map(|e| e.kind), Some("disabled"));
        let other = summary_error(SummaryError::Other("Nothing recognised.".into()));
        assert_eq!((other.kind, other.message.as_str()), ("internal", "Nothing recognised."));
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
