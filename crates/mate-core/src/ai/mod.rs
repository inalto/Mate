//! AI tutor plumbing: the verdict model, the provider abstraction and key storage.
//!
//! Nothing here touches the network unless the caller has checked `settings.aiConsent` and found
//! a key for the selected provider.

pub mod anthropic;
pub mod catalog;
pub mod keystore;
pub mod mock;
pub mod openai;
pub mod practice;
pub mod prompts;
pub mod provider;
pub mod verdict;

use provider::{AiError, Provider};
use verdict::Verdict;

pub fn is_known_provider(id: &str) -> bool {
    catalog::spec(id).is_some()
}

/// The model used when `settings.aiModel` is empty (may be empty: LM Studio and custom
/// endpoints have no default).
pub fn default_model(provider: &str) -> &'static str {
    catalog::spec(provider).map_or("", |s| s.default_model)
}

/// The provider for `settings_provider`. An empty `model` means the provider's default;
/// `base_url` overrides the catalog address where the provider allows it (local and custom).
/// `"mock"` gives an empty [`mock::MockProvider`]; unknown ids fall back to Anthropic. A refused
/// address (see [`catalog::effective_base_url`]) gives a provider that fails every call.
pub fn provider_for(settings_provider: &str, model: &str, key: String, base_url: Option<&str>) -> Box<dyn Provider> {
    if settings_provider == "mock" {
        return Box::new(mock::MockProvider::new(Vec::new()));
    }
    let spec = catalog::spec_or_default(settings_provider);
    let model = match model.trim() {
        "" => spec.default_model.to_string(),
        m => m.to_string(),
    };
    let Ok(base) = catalog::effective_base_url(spec.id, base_url.unwrap_or("")) else {
        return Box::new(BadAddress(spec.id));
    };
    match spec.wire {
        catalog::Wire::Anthropic => Box::new(anthropic::AnthropicProvider::new(key, model, base)),
        catalog::Wire::OpenAiCompat => Box::new(
            openai::OpenAiProvider::new(key, model, base).with_quirks(openai::Quirks::from_spec(spec)).with_id(spec.id),
        ),
    }
}

/// Stands in for a provider whose address setting was refused: every call fails with
/// [`AiError::BadAddress`] and nothing is sent.
struct BadAddress(&'static str);

impl Provider for BadAddress {
    fn id(&self) -> &'static str {
        self.0
    }
    fn recognize(&self, _req: &provider::RecognizeRequest) -> Result<Verdict, AiError> {
        Err(AiError::BadAddress)
    }
    fn complete(&self, _req: &provider::TextRequest) -> Result<String, AiError> {
        Err(AiError::BadAddress)
    }
    fn list_models(&self) -> Result<Vec<String>, AiError> {
        Err(AiError::BadAddress)
    }
}

/// Parses a provider's structured-output text into a validated [`Verdict`]. Enum strings are
/// compared case-insensitively (models sometimes capitalise them).
pub fn parse_verdict(text: &str) -> Result<Verdict, AiError> {
    let text = openai::extract_json_object(text).unwrap_or(text);
    let mut v: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|_| AiError::InvalidResponse("the answer was not JSON".into()))?;
    if !v.is_object() {
        return Err(AiError::InvalidResponse("the answer was not a JSON object".into()));
    }
    for key in ["domain", "errorNature"] {
        if let Some(s) = v[key].as_str() {
            v[key] = serde_json::Value::String(s.trim().to_lowercase());
        }
    }
    if let Some(s) = v["transcription"]["kind"].as_str() {
        v["transcription"]["kind"] = serde_json::Value::String(s.trim().to_lowercase());
    }
    let mut verdict: Verdict = serde_json::from_value(v)
        .map_err(|e| AiError::InvalidResponse(format!("unexpected fields: {e}")))?;
    verdict.validate();
    Ok(verdict)
}
