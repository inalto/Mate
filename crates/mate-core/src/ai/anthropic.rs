//! Anthropic Messages API provider (blocking; callers run it off the async runtime).
//!
//! The key is sent only in the `x-api-key` header. Neither the key nor request bodies are logged,
//! and `Debug` redacts the key.

use std::fmt;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

use super::parse_verdict;
use super::prompts::{RECOGNIZE_SYSTEM, recognize_user_text};
use super::provider::{AiError, Provider, RecognizeRequest, TextRequest};
use super::verdict::Verdict;

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Retries after the first attempt, on 429 / 5xx / network failures.
const RETRIES: u32 = 2;

pub struct AnthropicProvider {
    api_key: String,
    model: String,
    base_url: String,
    backoff: Duration,
    client: reqwest::blocking::Client,
}

impl fmt::Debug for AnthropicProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnthropicProvider")
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

enum Failure {
    /// Worth another attempt (408, 429, 5xx, network), optionally after the server's `retry-after`.
    Transient(AiError, Option<Duration>),
    Final(AiError),
}

/// Upper bound for one check, retries included, so a group is never in flight for long.
const DEADLINE: Duration = Duration::from_secs(90);
/// Longest `retry-after` honoured; longer waits fail now and are retried on a later settle.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);

impl AnthropicProvider {
    pub fn new(api_key: String, model: String, base_url: String) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        AnthropicProvider {
            api_key,
            model,
            base_url: base_url.trim_end_matches('/').to_string(),
            backoff: Duration::from_millis(800),
            client,
        }
    }

    /// First retry delay (doubles each retry). Tests shorten it.
    pub fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    /// POSTs `body` with retries and returns the first text block of the reply.
    fn send(&self, body: &Value) -> Result<String, AiError> {
        let start = Instant::now();
        let mut attempt = 0;
        loop {
            let left = DEADLINE.saturating_sub(start.elapsed());
            match self.send_once(body, left.min(TIMEOUT)) {
                Ok(text) => return Ok(text),
                Err(Failure::Final(e)) => return Err(e),
                Err(Failure::Transient(e, retry_after)) => {
                    let wait = match retry_after {
                        Some(ra) if ra > MAX_RETRY_AFTER => return Err(e),
                        Some(ra) => ra.max(self.backoff * 2u32.pow(attempt)),
                        None => self.backoff * 2u32.pow(attempt),
                    };
                    // Another try must fit in the deadline with at least a few seconds to run.
                    if attempt >= RETRIES || start.elapsed() + wait + Duration::from_secs(5) > DEADLINE {
                        return Err(e);
                    }
                    thread::sleep(wait);
                    attempt += 1;
                }
            }
        }
    }

    fn send_once(&self, body: &Value, timeout: Duration) -> Result<String, Failure> {
        let res = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .timeout(timeout)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .map_err(|e| Failure::Transient(network_error(&e), None))?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let text = res.text().map_err(|e| Failure::Transient(network_error(&e), None))?;
        match status {
            200..=299 => first_text_block(&text).map_err(Failure::Final),
            401 | 403 => Err(Failure::Final(AiError::Auth)),
            402 => Err(Failure::Final(AiError::Billing)),
            404 => Err(Failure::Final(AiError::UnknownModel)),
            400 | 413 | 422 => Err(Failure::Final(AiError::Rejected(api_message(&text, status)))),
            408 => Err(Failure::Transient(AiError::Network("the request timed out".into()), retry_after)),
            429 => Err(Failure::Transient(AiError::RateLimited, retry_after)),
            500..=599 => {
                Err(Failure::Transient(AiError::Network(format!("the service answered {status}")), retry_after))
            }
            _ => Err(Failure::Final(AiError::InvalidResponse(format!("unexpected status {status}")))),
        }
    }
}

fn network_error(e: &reqwest::Error) -> AiError {
    let what = if e.is_timeout() {
        "the request timed out"
    } else if e.is_connect() {
        "no connection"
    } else {
        "the request failed"
    };
    AiError::Network(what.to_string())
}

/// The API's own error message (never contains the key), shortened.
fn api_message(body: &str, status: u16) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("status {status}"));
    msg.chars().take(200).collect()
}

fn first_text_block(body: &str) -> Result<String, AiError> {
    let v: Value = serde_json::from_str(body).map_err(|_| AiError::InvalidResponse("not JSON".into()))?;
    match v["stop_reason"].as_str() {
        Some("refusal") => return Err(AiError::Refused),
        Some("max_tokens") => return Err(AiError::Truncated),
        _ => {}
    }
    v["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .map(str::to_string)
        .ok_or_else(|| AiError::InvalidResponse("no text in the reply".into()))
}

impl Provider for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn recognize(&self, req: &RecognizeRequest) -> Result<Verdict, AiError> {
        let data = base64::engine::general_purpose::STANDARD.encode(&req.image_png);
        let body = json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "thinking": { "type": "adaptive" },
            "output_config": {
                "effort": "medium",
                "format": { "type": "json_schema", "schema": Verdict::json_schema() }
            },
            "system": RECOGNIZE_SYSTEM,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": recognize_user_text(req) },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": data } }
                ]
            }]
        });
        let text = self.send(&body)?;
        parse_verdict(&text)
    }

    fn complete(&self, req: &TextRequest) -> Result<String, AiError> {
        let mut output_config = json!({ "effort": "medium" });
        if let Some(schema) = &req.json_schema {
            output_config["format"] = json!({ "type": "json_schema", "schema": schema });
        }
        let mut body = json!({
            "model": self.model,
            "max_tokens": req.max_tokens.max(1),
            "thinking": { "type": "adaptive" },
            "output_config": output_config,
            "messages": [{ "role": "user", "content": req.user }]
        });
        // An empty system prompt is omitted (the API rejects empty text).
        if !req.system.trim().is_empty() {
            body["system"] = json!(req.system);
        }
        self.send(&body)
    }
}
