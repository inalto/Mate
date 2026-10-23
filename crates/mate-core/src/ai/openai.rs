//! OpenAI Chat Completions provider (blocking; callers run it off the async runtime).
//!
//! The key is sent only in the `Authorization: Bearer` header. Neither the key nor request bodies are logged,
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

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";
/// `max_completion_tokens` is the parameter gpt-5 / reasoning models accept (`max_tokens` is rejected).
const MAX_TOKENS: u32 = 4096;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Retries after the first attempt, on 429 / 5xx / network failures.
const RETRIES: u32 = 2;

pub struct OpenAiProvider {
    api_key: String,
    model: String,
    base_url: String,
    backoff: Duration,
    client: reqwest::blocking::Client,
}

impl fmt::Debug for OpenAiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiProvider")
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

impl OpenAiProvider {
    pub fn new(api_key: String, model: String, base_url: String) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        OpenAiProvider {
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
            .post(format!("{}/v1/chat/completions", self.base_url))
            .timeout(timeout)
            .header("authorization", format!("Bearer {}", self.api_key))
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
            200..=299 => first_message(&text).map_err(Failure::Final),
            401 | 403 => Err(Failure::Final(AiError::Auth)),
            402 => Err(Failure::Final(AiError::Billing)),
            404 => Err(Failure::Final(AiError::UnknownModel)),
            400 | 413 | 422 => Err(Failure::Final(AiError::Rejected(api_message(&text, status)))),
            408 => Err(Failure::Transient(AiError::Network("the request timed out".into()), retry_after)),
            // An exhausted quota also comes back as 429; waiting does not fix it.
            429 if is_quota_exhausted(&text) => Err(Failure::Final(AiError::Billing)),
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

/// A 429 whose `error.code` (or `error.type`) is `insufficient_quota`: out of credit, not busy.
fn is_quota_exhausted(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .is_some_and(|v| ["code", "type"].iter().any(|k| v["error"][k].as_str() == Some("insufficient_quota")))
}

/// The API's own error message (never contains the key), shortened.
fn api_message(body: &str, status: u16) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("status {status}"));
    msg.chars().take(200).collect()
}

fn first_message(body: &str) -> Result<String, AiError> {
    let v: Value = serde_json::from_str(body).map_err(|_| AiError::InvalidResponse("not JSON".into()))?;
    let choice = &v["choices"][0];
    let message = &choice["message"];
    if message["refusal"].as_str().is_some_and(|r| !r.trim().is_empty()) {
        return Err(AiError::Refused);
    }
    match choice["finish_reason"].as_str() {
        Some("content_filter") => return Err(AiError::Refused),
        Some("length") => return Err(AiError::Truncated),
        _ => {}
    }
    message["content"]
        .as_str()
        .filter(|t| !t.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| AiError::InvalidResponse("no text in the reply".into()))
}

/// Rewrites a schema for OpenAI strict mode: `anyOf [T, null]` becomes `type: [T, "null"]`
/// (with `null` added to any `enum`). Everything else is kept; the shared schema already closes
/// every object and requires every property.
pub fn strict_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => nullable_inner(map).unwrap_or_else(|| {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), strict_schema(v))).collect())
        }),
        Value::Array(items) => Value::Array(items.iter().map(strict_schema).collect()),
        other => other.clone(),
    }
}

/// `anyOf [T, null]` with a typed `T`, as `T` with `type: [t, "null"]`.
fn nullable_inner(map: &serde_json::Map<String, Value>) -> Option<Value> {
    let options = map.get("anyOf")?.as_array()?;
    let is_null = |o: &Value| o["type"] == "null";
    if options.len() != 2 || !options.iter().any(is_null) {
        return None;
    }
    let mut inner = strict_schema(options.iter().find(|o| !is_null(o))?);
    let obj = inner.as_object_mut()?;
    let t = obj.get("type")?.as_str()?.to_string();
    obj.insert("type".into(), json!([t, "null"]));
    if let Some(Value::Array(e)) = obj.get_mut("enum") {
        e.push(Value::Null);
    }
    Some(inner)
}

fn response_format(schema: &Value, name: &str) -> Value {
    json!({ "type": "json_schema", "json_schema": { "name": name, "strict": true, "schema": strict_schema(schema) } })
}

impl Provider for OpenAiProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    fn recognize(&self, req: &RecognizeRequest) -> Result<Verdict, AiError> {
        let data = base64::engine::general_purpose::STANDARD.encode(&req.image_png);
        let body = json!({
            "model": self.model,
            "max_completion_tokens": MAX_TOKENS,
            "response_format": response_format(&Verdict::json_schema(), "verdict"),
            "messages": [
                { "role": "system", "content": RECOGNIZE_SYSTEM },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": recognize_user_text(req) },
                        { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{data}") } }
                    ]
                }
            ]
        });
        let text = self.send(&body)?;
        parse_verdict(&text)
    }

    fn complete(&self, req: &TextRequest) -> Result<String, AiError> {
        let mut messages = Vec::new();
        // An empty system prompt is omitted.
        if !req.system.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": req.system }));
        }
        messages.push(json!({ "role": "user", "content": req.user }));
        let mut body = json!({
            "model": self.model,
            "max_completion_tokens": req.max_tokens.max(1),
            "messages": messages
        });
        if let Some(schema) = &req.json_schema {
            body["response_format"] = response_format(schema, "result");
        }
        self.send(&body)
    }
}
