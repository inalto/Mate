//! OpenAI Chat Completions provider (blocking; callers run it off the async runtime). Also speaks
//! to every OpenAI-compatible service in the catalog, with that service's [`Quirks`].
//!
//! The key is sent only in the `Authorization: Bearer` header (and not at all when empty). Neither the key nor request bodies are logged,
//! and `Debug` redacts the key.

use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

use super::catalog::{ProviderSpec, Structured, TokenParam};
use super::parse_verdict;
use super::prompts::{RECOGNIZE_SYSTEM, recognize_user_text};
use super::provider::{AiError, Provider, RecognizeRequest, TextRequest};
use super::verdict::Verdict;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";
/// `max_completion_tokens` is the parameter gpt-5 / reasoning models accept (`max_tokens` is rejected).
const MAX_TOKENS: u32 = 4096;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Models on this computer can be slow, especially reading an image on a CPU.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
const LOCAL_DEADLINE: Duration = Duration::from_secs(180);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// Retries after the first attempt, on 429 / 5xx / network failures.
const RETRIES: u32 = 2;

/// How one OpenAI-compatible service differs from OpenAI itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quirks {
    pub chat_path: &'static str,
    pub models_path: Option<&'static str>,
    /// List only models whose `architecture.input_modalities` include `"image"` (OpenRouter).
    pub models_vision_only: bool,
    pub structured: Structured,
    pub token_param: TokenParam,
    /// Sent on every request (never secrets).
    pub extra_headers: &'static [(&'static str, &'static str)],
    /// A program on this computer: longer timeouts.
    pub local: bool,
}

impl Default for Quirks {
    /// OpenAI's own API.
    fn default() -> Self {
        Quirks {
            chat_path: "/v1/chat/completions",
            models_path: Some("/v1/models"),
            models_vision_only: false,
            structured: Structured::JsonSchema,
            token_param: TokenParam::MaxCompletionTokens,
            extra_headers: &[],
            local: false,
        }
    }
}

impl Quirks {
    pub fn from_spec(s: &ProviderSpec) -> Self {
        Quirks {
            chat_path: s.chat_path,
            models_path: s.models_path,
            models_vision_only: s.models_vision_only,
            structured: s.structured,
            token_param: s.token_param,
            extra_headers: s.extra_headers,
            local: s.local,
        }
    }
}

pub struct OpenAiProvider {
    api_key: String,
    model: String,
    base_url: String,
    backoff: Duration,
    quirks: Quirks,
    id: &'static str,
    timeout: Duration,
    deadline: Duration,
    /// How far structured output has been downgraded after the service refused a
    /// `response_format` (see [`level`]); never goes back up for this instance.
    downgrade: AtomicU8,
    client: reqwest::blocking::Client,
}

/// `JsonSchema` < `JsonObject` < `PromptOnly`: each step asks less of the service.
fn level(s: Structured) -> u8 {
    match s {
        Structured::JsonSchema => 0,
        Structured::JsonObject => 1,
        Structured::PromptOnly => 2,
    }
}

fn from_level(l: u8) -> Structured {
    match l {
        0 => Structured::JsonSchema,
        1 => Structured::JsonObject,
        _ => Structured::PromptOnly,
    }
}

impl fmt::Debug for OpenAiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiProvider")
            .field("id", &self.id)
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
    /// A 400 refusing the request's `response_format`: worth one try in a simpler mode.
    Format(AiError),
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
            base_url: base_url.trim().trim_end_matches('/').to_string(),
            backoff: Duration::from_millis(800),
            quirks: Quirks::default(),
            id: "openai",
            timeout: TIMEOUT,
            deadline: DEADLINE,
            downgrade: AtomicU8::new(0),
            client,
        }
    }

    pub fn with_quirks(mut self, quirks: Quirks) -> Self {
        self.quirks = quirks;
        if quirks.local {
            self.timeout = LOCAL_TIMEOUT;
            self.deadline = LOCAL_DEADLINE;
        }
        self
    }

    /// The catalog id reported by [`Provider::id`] (default `"openai"`).
    pub fn with_id(mut self, id: &'static str) -> Self {
        self.id = id;
        self
    }

    /// `base_url + path`. An address ending in `/v1` (as OpenAI-compatible servers are often
    /// given) neither doubles it for `/v1/…` paths nor keeps it for others (Ollama's `/api/tags`).
    fn url(&self, path: &str) -> String {
        let root = self.base_url.strip_suffix("/v1").unwrap_or(&self.base_url);
        format!("{root}{path}")
    }

    /// The structured-output mode to use now: the service's own, or a simpler one it fell back to.
    fn mode(&self) -> Structured {
        from_level(level(self.quirks.structured).max(self.downgrade.load(Ordering::Relaxed)))
    }

    /// Authorization (when a key is set) and the service's extra headers.
    fn headers(&self, mut req: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
        if !self.api_key.trim().is_empty() {
            req = req.header("authorization", format!("Bearer {}", self.api_key));
        }
        for (k, v) in self.quirks.extra_headers {
            req = req.header(*k, *v);
        }
        req
    }

    fn set_limit(&self, body: &mut Value, max: u32) {
        let field = match self.quirks.token_param {
            TokenParam::MaxTokens => "max_tokens",
            TokenParam::MaxCompletionTokens => "max_completion_tokens",
        };
        body[field] = json!(max);
    }

    /// The system prompt, with the schema appended when `mode` cannot enforce it.
    fn system_prompt(mode: Structured, system: &str, schema: Option<&Value>) -> String {
        match schema {
            Some(schema) if mode != Structured::JsonSchema => {
                let rule = format!(
                    "Reply with only one JSON object and no other text. It must match this JSON Schema:\n{schema}"
                );
                if system.trim().is_empty() { rule } else { format!("{system}\n\n{rule}") }
            }
            _ => system.to_string(),
        }
    }

    fn set_format(mode: Structured, body: &mut Value, schema: &Value, name: &str) {
        match mode {
            Structured::JsonSchema => body["response_format"] = response_format(schema, name),
            Structured::JsonObject => body["response_format"] = json!({ "type": "json_object" }),
            Structured::PromptOnly => {}
        }
    }

    /// First retry delay (doubles each retry). Tests shorten it.
    pub fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    /// POSTs `body` with retries and returns the first text block of the reply.
    fn send(&self, body: &Value) -> Result<String, AiError> {
        self.send_retrying(body).map_err(|f| match f {
            Failure::Transient(e, _) | Failure::Final(e) | Failure::Format(e) => e,
        })
    }

    /// Sends the body `build` makes for the current mode. When the service refuses the
    /// `response_format`, tries again in the next simpler mode (`json_schema`, then `json_object`,
    /// then prompt only) and keeps that mode for later calls.
    fn send_structured(&self, build: impl Fn(Structured) -> Value) -> Result<String, AiError> {
        loop {
            let mode = self.mode();
            match self.send_retrying(&build(mode)) {
                Ok(text) => return Ok(text),
                Err(Failure::Format(e)) => {
                    if mode == Structured::PromptOnly {
                        return Err(e);
                    }
                    self.downgrade.fetch_max(level(mode) + 1, Ordering::Relaxed);
                }
                Err(Failure::Transient(e, _) | Failure::Final(e)) => return Err(e),
            }
        }
    }

    fn send_retrying(&self, body: &Value) -> Result<String, Failure> {
        let start = Instant::now();
        let mut attempt = 0;
        loop {
            let left = self.deadline.saturating_sub(start.elapsed());
            match self.send_once(body, left.min(self.timeout)) {
                Ok(text) => return Ok(text),
                Err(f @ (Failure::Final(_) | Failure::Format(_))) => return Err(f),
                Err(Failure::Transient(e, retry_after)) => {
                    let wait = match retry_after {
                        Some(ra) if ra > MAX_RETRY_AFTER => return Err(Failure::Final(e)),
                        Some(ra) => ra.max(self.backoff * 2u32.pow(attempt)),
                        None => self.backoff * 2u32.pow(attempt),
                    };
                    // Another try must fit in the deadline with at least a few seconds to run.
                    if attempt >= RETRIES || start.elapsed() + wait + Duration::from_secs(5) > self.deadline {
                        return Err(Failure::Final(e));
                    }
                    thread::sleep(wait);
                    attempt += 1;
                }
            }
        }
    }

    fn send_once(&self, body: &Value, timeout: Duration) -> Result<String, Failure> {
        let res = self
            .headers(self.client.post(self.url(self.quirks.chat_path)))
            .timeout(timeout)
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
            400 if body.get("response_format").is_some() && mentions_format(&text) => {
                Err(Failure::Format(AiError::Rejected(api_message(&text, status))))
            }
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

/// Maps a model-list reply. Never retried: the user pressed a button and sees the answer.
pub(crate) fn model_list_reply(status: u16, body: &str, vision_only: bool) -> Result<Vec<String>, AiError> {
    match status {
        200..=299 => parse_model_list(body, vision_only),
        401 | 403 => Err(AiError::Auth),
        402 => Err(AiError::Billing),
        429 => Err(AiError::RateLimited),
        _ => Err(AiError::Network(format!("the service answered {status}"))),
    }
}

/// Model ids from an OpenAI-style (`data[].id`) or Ollama (`models[].name`) list, sorted and
/// deduplicated. With `vision_only`, only `data[]` entries whose
/// `architecture.input_modalities` include `"image"` are kept (OpenRouter).
pub fn parse_model_list(body: &str, vision_only: bool) -> Result<Vec<String>, AiError> {
    let v: Value = serde_json::from_str(body).map_err(|_| AiError::InvalidResponse("not JSON".into()))?;
    let reads_images = |m: &Value| {
        m["architecture"]["input_modalities"].as_array().is_some_and(|a| a.iter().any(|x| x == "image"))
    };
    let mut ids: Vec<String> = if let Some(data) = v["data"].as_array() {
        data.iter().filter(|m| !vision_only || reads_images(m)).filter_map(|m| m["id"].as_str()).map(str::to_string).collect()
    } else if let Some(models) = v["models"].as_array() {
        models.iter().filter_map(|m| m["name"].as_str().or(m["model"].as_str())).map(str::to_string).collect()
    } else {
        return Err(AiError::InvalidResponse("no model list in the reply".into()));
    };
    // Gemini lists `models/gemini-…`; its chat endpoint takes the bare id.
    for id in &mut ids {
        if let Some(bare) = id.strip_prefix("models/") {
            *id = bare.to_string();
        }
    }
    ids.retain(|id| !id.trim().is_empty());
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// The first balanced `{…}` in a reply that parses as a JSON object, skipping any
/// `<think>…</think>` preamble, code fences and prose around it (prose may itself hold braces, as in
/// `$\frac{1}{2}$`). Braces inside JSON strings are ignored.
pub fn extract_json_object(text: &str) -> Option<&str> {
    let hay = match text.rfind("</think>") {
        Some(i) => &text[i + "</think>".len()..],
        None => text,
    };
    hay.match_indices('{').find_map(|(open, _)| {
        let block = balanced_from(hay, open)?;
        serde_json::from_str::<Value>(block).ok().filter(Value::is_object).map(|_| block)
    })
}

/// The balanced `{…}` starting at byte `open` (a `{`), treating `"…"` as strings.
fn balanced_from(hay: &str, open: usize) -> Option<&str> {
    let (mut depth, mut in_str, mut escaped) = (0usize, false, false);
    for (i, &b) in hay.as_bytes().iter().enumerate().skip(open) {
        if in_str {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_str = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&hay[open..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// A 400 body that blames the `response_format` (or the `json_schema` in it).
fn mentions_format(body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    b.contains("response_format") || b.contains("json_schema")
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
        self.id
    }

    fn recognize(&self, req: &RecognizeRequest) -> Result<Verdict, AiError> {
        let data = base64::engine::general_purpose::STANDARD.encode(&req.image_png);
        let schema = Verdict::json_schema();
        let user_text = recognize_user_text(req);
        let text = self.send_structured(|mode| {
            let mut body = json!({
                "model": self.model,
                "messages": [
                    { "role": "system", "content": Self::system_prompt(mode, RECOGNIZE_SYSTEM, Some(&schema)) },
                    {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": user_text },
                            { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{data}") } }
                        ]
                    }
                ]
            });
            self.set_limit(&mut body, MAX_TOKENS);
            Self::set_format(mode, &mut body, &schema, "verdict");
            body
        })?;
        parse_verdict(&text)
    }

    fn complete(&self, req: &TextRequest) -> Result<String, AiError> {
        let build = |mode: Structured| {
            let mut messages = Vec::new();
            let system = Self::system_prompt(mode, &req.system, req.json_schema.as_ref());
            // An empty system prompt is omitted.
            if !system.trim().is_empty() {
                messages.push(json!({ "role": "system", "content": system }));
            }
            messages.push(json!({ "role": "user", "content": req.user }));
            let mut body = json!({ "model": self.model, "messages": messages });
            self.set_limit(&mut body, req.max_tokens.max(1));
            if let Some(schema) = &req.json_schema {
                Self::set_format(mode, &mut body, schema, "result");
            }
            body
        };
        if req.json_schema.is_none() {
            return self.send(&build(self.mode()));
        }
        let text = self.send_structured(build)?;
        // Services without enforced schemas wrap the object in prose or code fences.
        Ok(extract_json_object(&text).map_or(text.clone(), str::to_string))
    }

    fn list_models(&self) -> Result<Vec<String>, AiError> {
        let Some(path) = self.quirks.models_path else {
            return Err(AiError::Rejected("not supported".into()));
        };
        let res = self
            .headers(self.client.get(self.url(path)))
            .timeout(LIST_TIMEOUT)
            .send()
            .map_err(|e| network_error(&e))?;
        let status = res.status().as_u16();
        let text = res.text().map_err(|e| network_error(&e))?;
        model_list_reply(status, &text, self.quirks.models_vision_only)
    }
}
