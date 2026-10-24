//! `recognize_group`: sends one captured stroke group to the configured AI provider.
//!
//! Nothing is sent unless `settings.aiConsent` is on and a key is stored (local providers need
//! no key; custom ones need an address). The key is read from the
//! keychain here and handed to the provider; it never crosses IPC. The provider call is blocking
//! and runs in `spawn_blocking`; at most [`PER_PAGE_CONCURRENCY`] calls per page run at once.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex};

use base64::Engine;
use mate_core::ai::keystore::KeyStore;
use mate_core::ai::provider::{AiError, ContextLine, PracticeContext, Provider, RecognizeRequest};
use mate_core::ai::verdict::Verdict;
use mate_core::ai::catalog::{effective_base_url, spec_or_default};
use mate_core::ai::{default_model, provider_for};
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

/// A failure the frontend can act on: `kind` is one of `disabled`, `badAddress`, `auth`,
/// `billing`, `unknownModel`, `rateLimited`, `network`, `invalidResponse`, `refused`,
/// `truncated`, `rejected`, `internal`; `message` is a user-readable sentence.
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
            AiError::Billing => "billing",
            AiError::UnknownModel => "unknownModel",
            AiError::Refused => "refused",
            AiError::Truncated => "truncated",
            // Fixed in Settings; the message says what to change.
            AiError::BadAddress => "badAddress",
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

/// The verdict plus which provider and model produced it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeResult {
    #[serde(flatten)]
    pub verdict: Verdict,
    pub provider: String,
    pub model: String,
}

/// One provider instance, rebuilt only when the provider id, model, key or address changes. Real providers
/// hold a blocking HTTP client, which must be built and dropped off the async runtime: call
/// [`ProviderCache::get`] only from `spawn_blocking`.
#[derive(Default)]
pub struct ProviderCache(Mutex<Option<(u64, Arc<dyn Provider>)>>);

/// A hash identifying (provider, model, key, base URL); the key itself is never stored here.
fn fingerprint(provider: &str, model: &str, key: &str, base_url: &str) -> u64 {
    let mut h = DefaultHasher::new();
    (provider, model, key, base_url).hash(&mut h);
    h.finish()
}

impl ProviderCache {
    /// `base_url` overrides the catalog address where allowed; empty means the default.
    pub fn get(&self, provider: &str, model: &str, key: &str, base_url: &str) -> Arc<dyn Provider> {
        let fp = fingerprint(provider, model, key, base_url);
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((f, p)) = slot.as_ref()
            && *f == fp
        {
            return p.clone();
        }
        let p: Arc<dyn Provider> = Arc::from(provider_for(provider, model, key.to_string(), Some(base_url)));
        let old = slot.replace((fp, p.clone()));
        drop(slot);
        // The replaced provider (if this was its last user) is dropped here, off the runtime.
        drop(old);
        p
    }
}

/// The model actually used: the setting, or the provider's default when empty.
pub fn effective_model(provider: &str, model: &str) -> String {
    match model.trim() {
        "" => default_model(provider).to_string(),
        m => m.to_string(),
    }
}

/// What a provider call needs: the catalog id, the model setting (empty = default), the key
/// (empty for keyless providers) and the effective address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub provider: String,
    pub model: String,
    pub key: String,
    pub base_url: String,
}

/// The provider settings, without the consent check: `Disabled` when a needed key or address is
/// missing, `BadAddress` when the address is refused. Unknown provider ids fall back to Anthropic.
pub fn connection(settings: &Settings, store: &dyn KeyStore) -> Result<Resolved, AiError> {
    let spec = spec_or_default(&settings.ai_provider);
    let key = store.get(spec.id).map_err(|_| AiError::Disabled)?.filter(|k| !k.trim().is_empty());
    let key = match key {
        Some(k) => k,
        None if !spec.needs_key => String::new(),
        None => return Err(AiError::Disabled),
    };
    let base_url = effective_base_url(spec.id, &settings.ai_base_url).map_err(|_| AiError::BadAddress)?;
    if base_url.is_empty() {
        return Err(AiError::Disabled);
    }
    Ok(Resolved { provider: spec.id.to_string(), model: settings.ai_model.clone(), key, base_url })
}

/// The provider settings when checking is allowed; `Disabled` otherwise.
pub fn resolve(settings: &Settings, store: &dyn KeyStore) -> Result<Resolved, RecognizeError> {
    if settings.ai_consent != Some(true) || !settings.tutor_enabled {
        return Err(AiError::Disabled.into());
    }
    Ok(connection(settings, store)?)
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

/// Runs one provider call behind the page's gate. `make_prepare` is called once the permit is
/// held (so it sees the settings as they are now, not when the request was queued); the closure it
/// returns runs in `spawn_blocking` and decides whether to call, and with which provider and model.
pub async fn run_gated<M, P>(
    gates: &PageGates,
    page_id: &str,
    make_prepare: M,
    req: RecognizeRequest,
) -> Result<RecognizeResult, RecognizeError>
where
    M: FnOnce() -> Result<P, RecognizeError>,
    P: FnOnce() -> Result<(Arc<dyn Provider>, String), RecognizeError> + Send + 'static,
{
    let gate = gates.gate(page_id);
    let _permit = gate.acquire_owned().await.map_err(internal)?;
    let prepare = make_prepare()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (provider, model) = prepare()?;
        let verdict = provider.recognize(&req)?;
        Ok(RecognizeResult { verdict, provider: provider.id().to_string(), model })
    })
    .await
    .map_err(internal)?
}

#[tauri::command]
pub async fn recognize_group(
    state: State<'_, AppState>,
    req: RecognizeRequestDto,
) -> Result<RecognizeResult, RecognizeError> {
    let page_id = req.page_id.clone();
    let request = to_request(req)?;
    let make_prepare = || {
        // Consent, the tutor switch and the key are checked after waiting for a slot: turning
        // checking off stops queued requests too.
        let settings = state.settings.lock().map_err(internal)?.clone();
        let store: Arc<dyn KeyStore> = state.keys.clone();
        let cache = state.providers.clone();
        Ok(move || {
            let r = resolve(&settings, store.as_ref())?;
            let model = effective_model(&r.provider, &r.model);
            Ok((cache.get(&r.provider, &model, &r.key, &r.base_url), model))
        })
    };
    run_gated(&state.recognize_gates, &page_id, make_prepare, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;
    use mate_core::ai::provider::TextRequest;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn provider_cache_rebuilds_on_provider_switch_and_reuses_otherwise() {
        let cache = ProviderCache::default();
        let a = cache.get("anthropic", "", "k", "");
        assert_eq!(a.id(), "anthropic");
        assert!(Arc::ptr_eq(&a, &cache.get("anthropic", "", "k", "")));
        let o = cache.get("openai", "", "k", "");
        assert_eq!(o.id(), "openai");
        assert!(Arc::ptr_eq(&o, &cache.get("openai", "", "k", "")));
        assert_eq!(cache.get("anthropic", "", "k", "").id(), "anthropic");
        // A new address for the same provider builds a new one.
        let l = cache.get("ollama", "", "", "http://localhost:11434");
        assert_eq!(l.id(), "ollama");
        assert!(Arc::ptr_eq(&l, &cache.get("ollama", "", "", "http://localhost:11434")));
        assert!(!Arc::ptr_eq(&l, &cache.get("ollama", "", "", "http://gpu-box:11434")));
    }

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

        let r = resolve(&consenting(), &store).unwrap();
        assert_eq!((r.provider.as_str(), r.model.as_str(), r.key.as_str()), ("anthropic", "", "sk-1"));
        assert_eq!(r.base_url, "https://api.anthropic.com");
    }

    #[test]
    fn local_providers_need_no_key_and_custom_needs_an_address() {
        let store = MemoryStore::default();
        let local = Settings { ai_provider: "ollama".into(), ai_base_url: "http://10.0.0.7:11434".into(), ..consenting() };
        let r = resolve(&local, &store).unwrap();
        assert_eq!((r.provider.as_str(), r.key.as_str(), r.base_url.as_str()), ("ollama", "", "http://10.0.0.7:11434"));
        // A plain-http remote address is refused before anything is sent.
        let remote = Settings { ai_base_url: "http://box.example.org:11434".into(), ..local.clone() };
        let e = resolve(&remote, &store).unwrap_err();
        assert_eq!(e.kind, "badAddress");
        assert_eq!(e.message, AiError::BadAddress.to_string());
        let custom = Settings { ai_provider: "custom".into(), ..consenting() };
        assert_eq!(resolve(&custom, &store).unwrap_err().kind, "disabled");
        let custom = Settings { ai_base_url: "https://llm.example.org".into(), ..custom };
        store.set("custom", "opt").unwrap();
        let r = resolve(&custom, &store).unwrap();
        assert_eq!((r.key.as_str(), r.base_url.as_str()), ("opt", "https://llm.example.org"));
        // A cloud service ignores the address setting and still needs its key.
        let cloud = Settings { ai_provider: "groq".into(), ai_base_url: "http://elsewhere".into(), ..consenting() };
        assert_eq!(resolve(&cloud, &store).unwrap_err().kind, "disabled");
        store.set("groq", "gk").unwrap();
        assert_eq!(resolve(&cloud, &store).unwrap().base_url, "https://api.groq.com/openai");
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
        assert_eq!(RecognizeError::from(AiError::BadAddress).kind, "badAddress");
        let json = serde_json::to_value(RecognizeError::from(AiError::RateLimited)).unwrap();
        assert_eq!(json["kind"], "rateLimited");
        assert!(json["message"].as_str().unwrap().ends_with('.'));
    }

    /// Counts how many calls run at the same time.
    struct Slow {
        now: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
    }

    impl Provider for Slow {
        fn id(&self) -> &'static str {
            "mock"
        }
        fn recognize(&self, _req: &RecognizeRequest) -> Result<Verdict, AiError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(80));
            self.now.fetch_sub(1, Ordering::SeqCst);
            Ok(Verdict::default())
        }
        fn complete(&self, _req: &TextRequest) -> Result<String, AiError> {
            Err(AiError::Disabled)
        }
    }

    type Slowed = (Arc<dyn Provider>, Arc<AtomicUsize>, Arc<AtomicUsize>);

    fn slow() -> Slowed {
        let peak = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let p: Arc<dyn Provider> =
            Arc::new(Slow { now: Arc::new(AtomicUsize::new(0)), peak: peak.clone(), calls: calls.clone() });
        (p, peak, calls)
    }

    fn req() -> RecognizeRequest {
        RecognizeRequest { image_png: vec![1], context: vec![], difficulty: String::new(), practice: None }
    }

    type Prepared = Result<(Arc<dyn Provider>, String), RecognizeError>;

    /// `make_prepare` for tests: calls `p` while `allowed` is set, else refuses as Disabled.
    fn gate_on(
        p: Arc<dyn Provider>,
        allowed: Arc<AtomicBool>,
    ) -> impl FnOnce() -> Result<Box<dyn FnOnce() -> Prepared + Send + 'static>, RecognizeError> {
        move || {
            let f: Box<dyn FnOnce() -> Prepared + Send + 'static> = Box::new(move || {
                if allowed.load(Ordering::SeqCst) { Ok((p, "m".to_string())) } else { Err(AiError::Disabled.into()) }
            });
            Ok(f)
        }
    }

    #[test]
    fn at_most_two_calls_per_page() {
        let gates = Arc::new(PageGates::default());
        let (pa, peak, _) = slow();
        let (pb, other_peak, _) = slow();
        let on = Arc::new(AtomicBool::new(true));
        tauri::async_runtime::block_on(async {
            let mut tasks = Vec::new();
            for _ in 0..6 {
                let (gates, p, on) = (gates.clone(), pa.clone(), on.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    run_gated(&gates, "page-a", gate_on(p, on), req()).await
                }));
            }
            // Another page is not held back by page-a.
            let (gates_b, on_b) = (gates.clone(), on.clone());
            tasks.push(tauri::async_runtime::spawn(async move {
                run_gated(&gates_b, "page-b", gate_on(pb, on_b), req()).await
            }));
            for t in tasks {
                let res = t.await.unwrap().unwrap();
                assert_eq!(res.provider, "mock");
            }
        });
        assert_eq!(peak.load(Ordering::SeqCst), PER_PAGE_CONCURRENCY);
        assert_eq!(other_peak.load(Ordering::SeqCst), 1);
    }

    /// Blocks every call until released; counts calls.
    struct Held {
        calls: Arc<AtomicUsize>,
        released: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    }

    impl Provider for Held {
        fn id(&self) -> &'static str {
            "mock"
        }
        fn recognize(&self, _req: &RecognizeRequest) -> Result<Verdict, AiError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let (lock, cv) = &*self.released;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            Ok(Verdict::default())
        }
        fn complete(&self, _req: &TextRequest) -> Result<String, AiError> {
            Err(AiError::Disabled)
        }
    }

    #[test]
    fn consent_off_stops_queued_requests() {
        let gates = Arc::new(PageGates::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let released = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let p: Arc<dyn Provider> = Arc::new(Held { calls: calls.clone(), released: released.clone() });
        let on = Arc::new(AtomicBool::new(true));
        let results = tauri::async_runtime::block_on(async {
            let mut tasks = Vec::new();
            for _ in 0..3 {
                let (gates, p, on) = (gates.clone(), p.clone(), on.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    run_gated(&gates, "page", gate_on(p, on), req()).await
                }));
            }
            // Wait until the first two hold the page's slots (the third is queued behind them).
            let c = calls.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while c.load(Ordering::SeqCst) < 2 {
                    assert!(std::time::Instant::now() < deadline, "the first two calls never started");
                    std::thread::yield_now();
                }
            })
            .await
            .unwrap();
            on.store(false, Ordering::SeqCst);
            {
                let (lock, cv) = &*released;
                *lock.lock().unwrap() = true;
                cv.notify_all();
            }
            let mut out = Vec::new();
            for t in tasks {
                out.push(t.await.unwrap());
            }
            out
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 2);
        assert_eq!(results.iter().filter(|r| matches!(r, Err(e) if e.kind == "disabled")).count(), 1);
    }

    #[test]
    fn provider_cache_builds_off_the_runtime_and_reuses() {
        // Building and dropping the real provider (a blocking HTTP client) from a tokio task must
        // not panic in debug builds: the cache is only used inside spawn_blocking.
        let cache = Arc::new(ProviderCache::default());
        let c = cache.clone();
        let same = tauri::async_runtime::block_on(async move {
            tauri::async_runtime::spawn(async move {
                tauri::async_runtime::spawn_blocking(move || {
                    let a = c.get("anthropic", "claude-opus-5-5", "sk-1", "");
                    let b = c.get("anthropic", "claude-opus-5-5", "sk-1", "");
                    let same = Arc::ptr_eq(&a, &b);
                    drop((a, b));
                    // A new key replaces it (the old one is dropped on this blocking thread).
                    let d = c.get("anthropic", "claude-opus-5-5", "sk-2", "");
                    let e = c.get("anthropic", "claude-opus-5-5", "sk-2", "");
                    same && Arc::ptr_eq(&d, &e) && d.id() == "anthropic"
                })
                .await
                .unwrap()
            })
            .await
            .unwrap()
        });
        assert!(same);
        // Release the cached client off the runtime too.
        std::thread::spawn(move || drop(cache)).join().unwrap();
        assert_ne!(fingerprint("anthropic", "m", "a", ""), fingerprint("anthropic", "m", "b", ""));
        assert_ne!(fingerprint("ollama", "m", "", "http://a"), fingerprint("ollama", "m", "", "http://b"));
        assert_eq!(effective_model("anthropic", " "), "claude-opus-5-5");
    }
}
