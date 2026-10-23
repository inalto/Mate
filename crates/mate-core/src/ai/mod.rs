//! AI tutor plumbing: the verdict model, the provider abstraction and key storage.
//!
//! Nothing here touches the network unless the caller has checked `settings.aiConsent` and found
//! a key for the selected provider.

pub mod anthropic;
pub mod keystore;
pub mod mock;
pub mod openai;
pub mod practice;
pub mod prompts;
pub mod provider;
pub mod verdict;

use provider::{AiError, Provider};
use verdict::Verdict;

/// Provider ids accepted from settings and the UI.
pub const PROVIDERS: [&str; 2] = ["anthropic", "openai"];

pub fn is_known_provider(id: &str) -> bool {
    PROVIDERS.contains(&id)
}

/// The model used when `settings.aiModel` is empty.
pub fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-opus-5-5",
        "openai" => "gpt-5",
        _ => "",
    }
}

/// The provider for `settings_provider`. An empty `model` means the provider's default.
/// `"mock"` gives an empty [`mock::MockProvider`]; unknown ids fall back to Anthropic.
pub fn provider_for(settings_provider: &str, model: &str, key: String) -> Box<dyn Provider> {
    let model = match model.trim() {
        "" => default_model(settings_provider).to_string(),
        m => m.to_string(),
    };
    match settings_provider {
        "mock" => Box::new(mock::MockProvider::new(Vec::new())),
        "openai" => Box::new(openai::OpenAiProvider::new(key, model, openai::DEFAULT_BASE_URL.to_string())),
        _ => Box::new(anthropic::AnthropicProvider::new(key, model, anthropic::DEFAULT_BASE_URL.to_string())),
    }
}

/// Parses a provider's structured-output text into a validated [`Verdict`]. Enum strings are
/// compared case-insensitively (models sometimes capitalise them).
pub fn parse_verdict(text: &str) -> Result<Verdict, AiError> {
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
