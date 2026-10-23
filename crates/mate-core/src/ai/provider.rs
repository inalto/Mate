//! The provider abstraction: one blocking call per check (callers run it in `spawn_blocking`).

use serde_json::Value;

use super::verdict::Verdict;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextLine {
    pub content: String,
    /// True for the line being checked now; false for earlier lines given as context.
    pub is_new: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PracticeContext {
    pub question: String,
    pub expected_answer: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecognizeRequest {
    pub image_png: Vec<u8>,
    pub context: Vec<ContextLine>,
    pub difficulty: String,
    pub practice: Option<PracticeContext>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextRequest {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
    /// When set, the provider asks for structured output matching this schema.
    pub json_schema: Option<Value>,
}

/// Failures, worded for the user (they reach the UI as-is).
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("The API key was not accepted. Check it in Settings.")]
    Auth,
    #[error("The AI service is busy right now. Try again in a moment.")]
    RateLimited,
    #[error("Could not reach the AI service ({0}).")]
    Network(String),
    #[error("The AI service sent a reply that could not be read ({0}).")]
    InvalidResponse(String),
    #[error("AI checking is off. Turn it on in Settings.")]
    Disabled,
    #[error("The AI service refused this request ({0}).")]
    Rejected(String),
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn recognize(&self, req: &RecognizeRequest) -> Result<Verdict, AiError>;
    fn complete(&self, req: &TextRequest) -> Result<String, AiError>;
}
