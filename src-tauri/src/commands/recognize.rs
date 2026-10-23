//! `recognize_group`: sends one captured stroke group to the configured AI provider.
//!
//! Nothing is sent unless `settings.aiConsent` is on and a key is stored. The key is read from the
//! keychain here and handed to the provider; it never crosses IPC. The provider call is blocking
//! and runs in `spawn_blocking`; at most [`PER_PAGE_CONCURRENCY`] calls per page run at once.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use mate_core::ai::keystore::KeyStore;
use mate_core::ai::provider::{AiError, ContextLine, PracticeContext, Provider, RecognizeRequest};
use mate_core::ai::verdict::Verdict;
use mate_core::ai::{is_known_provider, provider_for};
use mate_core::settings::Settings;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Semaphore;

use crate::state::AppState;

pub const PER_PAGE_CONCURRENCY: usize = 2;
/// Context lines beyond this are dropped (the frontend already sends at most 11).
const MAX_CONTEXT: usize = 11;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLineDto {
    pub content: String,
    #[serde(default)]
    pub is_new: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeDto {
    pub question: String,
    pub expected_answer: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeRequestDto {
    /// Groups the request under its page for the concurrency gate. Other fields the frontend
    /// sends (e.g. the stroke group id) are ignored.
    pub page_id: String,
    /// The group image, PNG, base64 (no data-URL prefix).
    pub image_png_base64: String,
    #[serde(default)]
    pub context: Vec<ContextLineDto>,
    #[serde(default)]
    pub difficulty: Option<String>,
    #[serde(default)]
    pub practice: Option<PracticeDto>,
}

/// A failure the frontend can act on: `kind` is one of `disabled`, `auth`, `rateLimited`,
/// `network`, `invalidResponse`, `rejected`, `internal`; `message` is a user-readable sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeError {
    pub kind: &'static str,
    pub message: String,
}

impl From<AiError> for RecognizeError {
    fn from(e: AiError) -> Self {
        let kind = match &e {
            AiError::Auth => "auth",
            AiError::RateLimited => "rateLimited",
            AiError::Network(_) => "network",
            AiError::InvalidResponse(_) => "invalidResponse",
            AiError::Disabled => "disabled",
            AiError::Rejected(_) => "rejected",
        };
        RecognizeError { kind, message: e.to_string() }
    }
}

fn internal(msg: impl ToString) -> RecognizeError {
    RecognizeError { kind: "internal", message: msg.to_string() }
}

/// Per-page limit on concurrent provider calls.
#[derive(Default)]
pub struct PageGates(Mutex<HashMap<String, Arc<Semaphore>>>);

impl PageGates {
    pub fn gate(&self, page_id: &str) -> Arc<Semaphore> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Drop idle gates of other pages so the map does not grow without bound.
        map.retain(|id, s| id == page_id || Arc::strong_count(s) > 1);
        map.entry(page_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(PER_PAGE_CONCURRENCY)))
            .clone()
    }
}

/// Provider id, model and key when checking is allowed; `Disabled` otherwise.
pub fn resolve(settings: &Settings, store: &dyn KeyStore) -> Result<(String, String, String), RecognizeError> {
    if settings.ai_consent != Some(true) || !settings.tutor_enabled {
        return Err(AiError::Disabled.into());
    }
    let provider = if is_known_provider(&settings.ai_provider) {
        settings.ai_provider.clone()
    } else {
        "anthropic".to_string()
    };
    let key = store.get(&provider).map_err(internal)?.filter(|k| !k.trim().is_empty());
    let Some(key) = key else { return Err(AiError::Disabled.into()) };
    Ok((provider, settings.ai_model.clone(), key))
}

pub fn to_request(dto: RecognizeRequestDto) -> Result<RecognizeRequest, RecognizeError> {
    let image_png = base64::engine::general_purpose::STANDARD
        .decode(dto.image_png_base64.trim())
        .map_err(|_| internal("The captured image could not be read."))?;
    if image_png.is_empty() {
        return Err(internal("The captured image is empty."));
    }
    Ok(RecognizeRequest {
        image_png,
        context: dto
            .context
            .into_iter()
            .filter(|l| !l.content.trim().is_empty())
            .take(MAX_CONTEXT)
            .map(|l| ContextLine { content: l.content, is_new: l.is_new })
            .collect(),
        difficulty: dto.difficulty.unwrap_or_default(),
        practice: dto.practice.map(|p| PracticeContext { question: p.question, expected_answer: p.expected_answer }),
    })
}

/// Runs one blocking provider call behind the page's gate.
pub async fn run_gated(
    gates: &PageGates,
    page_id: &str,
    provider: Box<dyn Provider>,
    req: RecognizeRequest,
) -> Result<Verdict, RecognizeError> {
    let gate = gates.gate(page_id);
    let _permit = gate.acquire_owned().await.map_err(internal)?;
    tauri::async_runtime::spawn_blocking(move || provider.recognize(&req))
        .await
        .map_err(internal)?
        .map_err(RecognizeError::from)
}

#[tauri::command]
pub async fn recognize_group(state: State<'_, AppState>, req: RecognizeRequestDto) -> Result<Verdict, RecognizeError> {
    let settings = state.settings.lock().map_err(internal)?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    // The keychain can block on OS prompts: read it off the async runtime.
    let (provider_id, model, key) = tauri::async_runtime::spawn_blocking(move || resolve(&settings, store.as_ref()))
        .await
        .map_err(internal)??;
    let page_id = req.page_id.clone();
    let request = to_request(req)?;
    let provider = provider_for(&provider_id, &model, key);
    run_gated(&state.recognize_gates, &page_id, provider, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;
    use mate_core::ai::provider::TextRequest;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn consenting() -> Settings {
        Settings { ai_consent: Some(true), ..Settings::default() }
    }

    #[test]
    fn refuses_without_consent_or_key() {
        let store = MemoryStore::default();
        store.set("anthropic", "sk-1").unwrap();
        let e = resolve(&Settings::default(), &store).unwrap_err();
        assert_eq!(e.kind, "disabled");
        let off = Settings { tutor_enabled: false, ..consenting() };
        assert_eq!(resolve(&off, &store).unwrap_err().kind, "disabled");

        let empty = MemoryStore::default();
        assert_eq!(resolve(&consenting(), &empty).unwrap_err().kind, "disabled");

        let (p, m, k) = resolve(&consenting(), &store).unwrap();
        assert_eq!((p.as_str(), m.as_str(), k.as_str()), ("anthropic", "", "sk-1"));
    }

    #[test]
    fn decodes_the_request_and_caps_context() {
        let dto = RecognizeRequestDto {
            page_id: "p".into(),
            image_png_base64: base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]),
            context: (0..20).map(|i| ContextLineDto { content: format!("l{i}"), is_new: false }).collect(),
            difficulty: None,
            practice: None,
        };
        let req = to_request(dto.clone()).unwrap();
        assert_eq!(req.image_png, vec![1, 2, 3]);
        assert_eq!(req.context.len(), MAX_CONTEXT);
        let bad = RecognizeRequestDto { image_png_base64: "%%%".into(), ..dto };
        assert_eq!(to_request(bad).unwrap_err().kind, "internal");
    }

    #[test]
    fn errors_carry_a_kind() {
        assert_eq!(RecognizeError::from(AiError::Auth).kind, "auth");
        assert_eq!(RecognizeError::from(AiError::Network("x".into())).kind, "network");
        let json = serde_json::to_value(RecognizeError::from(AiError::RateLimited)).unwrap();
        assert_eq!(json["kind"], "rateLimited");
        assert!(json["message"].as_str().unwrap().ends_with('.'));
    }

    /// Counts how many calls run at the same time.
    struct Slow {
        now: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
    }

    impl Provider for Slow {
        fn id(&self) -> &'static str {
            "mock"
        }
        fn recognize(&self, _req: &RecognizeRequest) -> Result<Verdict, AiError> {
            let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(40));
            self.now.fetch_sub(1, Ordering::SeqCst);
            Ok(Verdict::default())
        }
        fn complete(&self, _req: &TextRequest) -> Result<String, AiError> {
            Err(AiError::Disabled)
        }
    }

    #[test]
    fn at_most_two_calls_per_page() {
        let gates = Arc::new(PageGates::default());
        let now = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let other_peak = Arc::new(AtomicUsize::new(0));
        tauri::async_runtime::block_on(async {
            let mut tasks = Vec::new();
            for _ in 0..6 {
                let gates = gates.clone();
                let provider = Slow { now: now.clone(), peak: peak.clone() };
                tasks.push(tauri::async_runtime::spawn(async move {
                    let req = RecognizeRequest { image_png: vec![1], context: vec![], difficulty: String::new(), practice: None };
                    run_gated(&gates, "page-a", Box::new(provider), req).await
                }));
            }
            // Another page is not held back by page-a.
            let gates_b = gates.clone();
            let b = Slow { now: Arc::new(AtomicUsize::new(0)), peak: other_peak.clone() };
            tasks.push(tauri::async_runtime::spawn(async move {
                let req = RecognizeRequest { image_png: vec![1], context: vec![], difficulty: String::new(), practice: None };
                run_gated(&gates_b, "page-b", Box::new(b), req).await
            }));
            for t in tasks {
                assert!(t.await.unwrap().is_ok());
            }
        });
        assert_eq!(peak.load(Ordering::SeqCst), PER_PAGE_CONCURRENCY);
        assert_eq!(other_peak.load(Ordering::SeqCst), 1);
    }
}
