//! AI tutor plumbing: the verdict model, the provider abstraction and key storage.
//!
//! Nothing here touches the network unless the caller has checked `settings.aiConsent` and found
//! a key for the selected provider.

pub mod keystore;
pub mod mock;
pub mod provider;
pub mod verdict;

use provider::{AiError, Provider, RecognizeRequest, TextRequest};
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

/// The provider for `settings_provider`. Real providers are not wired up yet and report
/// [`AiError::Disabled`]; `"mock"` gives an empty [`mock::MockProvider`].
pub fn provider_for(settings_provider: &str, model: &str, key: String) -> Box<dyn Provider> {
    let _ = (model, key);
    match settings_provider {
        "mock" => Box::new(mock::MockProvider::new(Vec::new())),
        "openai" => Box::new(DisabledProvider("openai")),
        _ => Box::new(DisabledProvider("anthropic")),
    }
}

/// Placeholder that refuses every call.
struct DisabledProvider(&'static str);

impl Provider for DisabledProvider {
    fn id(&self) -> &'static str {
        self.0
    }

    fn recognize(&self, _req: &RecognizeRequest) -> Result<Verdict, AiError> {
        Err(AiError::Disabled)
    }

    fn complete(&self, _req: &TextRequest) -> Result<String, AiError> {
        Err(AiError::Disabled)
    }
}
