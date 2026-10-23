//! A scripted provider for tests: returns its results in order and records every request.

use std::collections::VecDeque;
use std::sync::Mutex;

use super::provider::{AiError, Provider, RecognizeRequest, TextRequest};
use super::verdict::Verdict;

#[derive(Default)]
pub struct MockProvider {
    verdicts: Mutex<VecDeque<Result<Verdict, AiError>>>,
    texts: Mutex<VecDeque<Result<String, AiError>>>,
    requests: Mutex<Vec<RecognizeRequest>>,
    text_requests: Mutex<Vec<TextRequest>>,
}

impl MockProvider {
    pub fn new(scripted: Vec<Result<Verdict, AiError>>) -> Self {
        MockProvider {
            verdicts: Mutex::new(scripted.into()),
            ..MockProvider::default()
        }
    }

    /// Scripts the replies to `complete`, in order.
    pub fn with_text(self, scripted: Vec<Result<String, AiError>>) -> Self {
        *self.texts.lock().unwrap() = scripted.into();
        self
    }

    /// Every `recognize` request received so far.
    pub fn requests(&self) -> Vec<RecognizeRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// Every `complete` request received so far.
    pub fn text_requests(&self) -> Vec<TextRequest> {
        self.text_requests.lock().unwrap().clone()
    }
}

fn exhausted() -> AiError {
    AiError::InvalidResponse("mock script exhausted".into())
}

impl Provider for MockProvider {
    fn id(&self) -> &'static str {
        "mock"
    }

    fn recognize(&self, req: &RecognizeRequest) -> Result<Verdict, AiError> {
        self.requests.lock().unwrap().push(req.clone());
        self.verdicts.lock().unwrap().pop_front().unwrap_or_else(|| Err(exhausted()))
    }

    fn complete(&self, req: &TextRequest) -> Result<String, AiError> {
        self.text_requests.lock().unwrap().push(req.clone());
        self.texts.lock().unwrap().pop_front().unwrap_or_else(|| Err(exhausted()))
    }
}
