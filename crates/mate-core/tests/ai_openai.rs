//! The OpenAI provider against a local stub HTTP server. Never touches the real network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine;
use mate_core::ai::catalog::{Structured, TokenParam};
use mate_core::ai::openai::{OpenAiProvider, Quirks, parse_model_list, strict_schema};
use mate_core::ai::provider_for;
use mate_core::ai::provider::{AiError, ContextLine, Provider, RecognizeRequest, TextRequest};
use mate_core::ai::verdict::{Verdict, VerdictCode, VerdictKind};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
struct Seen {
    path: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Serves the scripted `(status, body)` replies in order, one per connection, recording requests.
fn stub(replies: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for (status, body) in replies {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
            let mut headers = Vec::new();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                if let Some((k, v)) = h.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        len = v.trim().parse().unwrap();
                    }
                    headers.push((k.trim().to_string(), v.trim().to_string()));
                }
            }
            let mut buf = vec![0; len];
            reader.read_exact(&mut buf).unwrap();
            let body_json = serde_json::from_slice(&buf).unwrap_or(Value::Null);
            log.lock().unwrap().push(Seen { path, headers, body: body_json });
            let mut stream = stream;
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.flush();
        }
    });
    (base, seen)
}

fn verdict_json() -> Value {
    json!({
        "description": "x equals two", "latex": "x=2", "correct": false, "domain": "Algebra",
        "errorNature": "procedural", "hint": "Check the subtraction.",
        "explanation": "Subtracting 1 from both sides gives a different value.",
        "nextSteps": "Redo the last step.", "focusSpan": "2", "illegible": false, "transcription": null
    })
}

fn reply_with(message: Value, finish: &str) -> (u16, String) {
    (200, json!({ "id": "c1", "choices": [{ "index": 0, "finish_reason": finish, "message": message }] }).to_string())
}

fn ok_reply(v: &Value) -> (u16, String) {
    reply_with(json!({ "role": "assistant", "content": v.to_string(), "refusal": null }), "stop")
}

fn request() -> RecognizeRequest {
    RecognizeRequest {
        image_png: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
        context: vec![ContextLine { content: "x+1=3".into(), is_new: false }],
        difficulty: "intermediate".into(),
        practice: None,
    }
}

fn provider(base: &str) -> OpenAiProvider {
    OpenAiProvider::new("sk-test-secret".into(), "gpt-5".into(), base.into()).with_backoff(Duration::from_millis(10))
}

#[test]
fn openai_request_has_image_url_and_json_schema() {
    let (base, seen) = stub(vec![ok_reply(&verdict_json())]);
    provider(&base).recognize(&request()).unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let r = &seen[0];
    assert_eq!(r.path, "/v1/chat/completions");
    assert_eq!(r.header("authorization"), Some("Bearer sk-test-secret"));
    assert!(r.header("content-type").unwrap().starts_with("application/json"));
    let b = &r.body;
    assert_eq!(b["model"], "gpt-5");
    assert_eq!(b["max_completion_tokens"], 4096);
    assert!(b.get("max_tokens").is_none());
    let rf = &b["response_format"];
    assert_eq!(rf["type"], "json_schema");
    assert_eq!(rf["json_schema"]["strict"], true);
    assert_eq!(rf["json_schema"]["name"], "verdict");
    assert_eq!(rf["json_schema"]["schema"], strict_schema(&Verdict::json_schema()));
    let msgs = b["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["role"], "system");
    assert!(msgs[0]["content"].as_str().unwrap().contains("Never solve the problem"));
    assert_eq!(msgs[1]["role"], "user");
    let content = msgs[1]["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert!(content[0]["text"].as_str().unwrap().contains("x+1=3"));
    assert_eq!(content[1]["type"], "image_url");
    let url = content[1]["image_url"]["url"].as_str().unwrap();
    let data = url.strip_prefix("data:image/png;base64,").expect("data URL");
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(data).unwrap(), request().image_png);
}

#[test]
fn openai_parses_verdict() {
    let (base, _) = stub(vec![ok_reply(&verdict_json())]);
    let v = provider(&base).recognize(&request()).unwrap();
    assert_eq!(v.latex, "x=2");
    assert_eq!(v.correct, Some(false));
    assert_eq!(v.code, VerdictCode::Algebra);
    assert_eq!(v.kind, VerdictKind::Math);
    assert_eq!(v.hint.as_deref(), Some("Check the subtraction."));
}

#[test]
fn factory_picks_provider_from_settings() {
    assert_eq!(provider_for("openai", "", "k".into(), None).id(), "openai");
    assert_eq!(provider_for("anthropic", "", "k".into(), None).id(), "anthropic");
    assert_eq!(provider_for("mock", "", String::new(), None).id(), "mock");
    // Unknown ids fall back to the default provider.
    assert_eq!(provider_for("other", "", "k".into(), None).id(), "anthropic");
    // The default model for OpenAI is gpt-5 and reaches the wire.
    let (base, seen) = stub(vec![ok_reply(&verdict_json())]);
    let p = OpenAiProvider::new("k".into(), mate_core::ai::default_model("openai").into(), base);
    p.recognize(&request()).unwrap();
    assert_eq!(seen.lock().unwrap()[0].body["model"], "gpt-5");
}

#[test]
fn openai_maps_401_to_auth_without_retry() {
    let err = r#"{"error":{"message":"Incorrect API key provided: sk-test-secret","type":"invalid_request_error"}}"#;
    let (base, seen) = stub(vec![(401, err.into()), ok_reply(&verdict_json())]);
    let e = provider(&base).recognize(&request()).unwrap_err();
    assert!(matches!(e, AiError::Auth), "{e:?}");
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(!e.to_string().contains("sk-test"));
}

#[test]
fn openai_maps_other_statuses() {
    let err = r#"{"error":{"message":"image too large"}}"#;
    let (base, _) = stub(vec![(400, err.into())]);
    match provider(&base).recognize(&request()) {
        Err(AiError::Rejected(m)) => assert!(m.contains("image too large")),
        other => panic!("{other:?}"),
    }
    let (base, _) = stub(vec![(403, err.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::Auth)));
    let (base, _) = stub(vec![(402, err.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::Billing)));
    let (base, _) = stub(vec![(404, err.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::UnknownModel)));
}

#[test]
fn openai_refusal_and_cut_off_are_final() {
    let refusal = reply_with(json!({ "role": "assistant", "content": null, "refusal": "I can't help with that." }), "stop");
    let cut = reply_with(json!({ "role": "assistant", "content": "{", "refusal": null }), "length");
    for (reply, refused) in [(refusal, true), (cut, false)] {
        let (base, seen) = stub(vec![reply, ok_reply(&verdict_json())]);
        let e = provider(&base).recognize(&request()).unwrap_err();
        if refused {
            assert!(matches!(e, AiError::Refused), "{e:?}");
        } else {
            assert!(matches!(e, AiError::Truncated), "{e:?}");
        }
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}

#[test]
fn openai_429_insufficient_quota_is_billing_without_retry() {
    let quota = r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}"#;
    let (base, seen) = stub(vec![(429, quota.into()), ok_reply(&verdict_json())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::Billing)));
    assert_eq!(seen.lock().unwrap().len(), 1);
    // Only the code alone also counts; any other 429 stays a rate limit.
    let code_only = r#"{"error":{"message":"quota","code":"insufficient_quota"}}"#;
    let (base, _) = stub(vec![(429, code_only.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::Billing)));
    let busy = r#"{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}"#;
    let (base, seen) = stub(vec![(429, busy.into()), ok_reply(&verdict_json())]);
    assert!(provider(&base).recognize(&request()).is_ok());
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[test]
fn openai_retries_429_and_5xx_then_gives_up() {
    let busy = r#"{"error":{"message":"slow down"}}"#;
    let (base, seen) = stub(vec![(429, busy.into()), (503, busy.into()), ok_reply(&verdict_json())]);
    assert!(provider(&base).recognize(&request()).is_ok());
    assert_eq!(seen.lock().unwrap().len(), 3);
    let (base, seen) = stub(vec![(429, busy.into()), (429, busy.into()), (429, busy.into()), (429, busy.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::RateLimited)));
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[test]
fn openai_network_failure_and_bad_json() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = provider(&format!("http://127.0.0.1:{port}")).recognize(&request()).unwrap_err();
    assert!(matches!(e, AiError::Network(_)), "{e:?}");
    let (base, _) = stub(vec![reply_with(json!({ "content": "not json", "refusal": null }), "stop")]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::InvalidResponse(_))));
}

#[test]
fn openai_complete_returns_text_and_schema() {
    let (base, seen) = stub(vec![reply_with(json!({ "content": "A short summary.", "refusal": null }), "stop")]);
    let out = provider(&base)
        .complete(&TextRequest { system: "sys".into(), user: "hello".into(), max_tokens: 300, json_schema: None })
        .unwrap();
    assert_eq!(out, "A short summary.");
    let b = &seen.lock().unwrap()[0].body;
    assert_eq!(b["max_completion_tokens"], 300);
    assert_eq!(b["messages"][0], json!({ "role": "system", "content": "sys" }));
    assert_eq!(b["messages"][1], json!({ "role": "user", "content": "hello" }));
    assert!(b.get("response_format").is_none());

    let (base, seen) = stub(vec![reply_with(json!({ "content": "{}", "refusal": null }), "stop")]);
    let schema = json!({ "type": "object", "additionalProperties": false, "required": [], "properties": {} });
    provider(&base)
        .complete(&TextRequest { system: String::new(), user: "u".into(), max_tokens: 10, json_schema: Some(schema) })
        .unwrap();
    let b = &seen.lock().unwrap()[0].body;
    assert_eq!(b["messages"].as_array().unwrap().len(), 1);
    assert_eq!(b["response_format"]["json_schema"]["strict"], true);
}

#[test]
fn openai_debug_hides_the_key() {
    let p = OpenAiProvider::new("sk-test-secret".into(), "m".into(), "http://x".into());
    assert!(!format!("{p:?}").contains("sk-test-secret"));
}

/// Every object closed and fully required, no `anyOf`, no unsupported keywords.
fn check_strict(node: &Value) {
    match node {
        Value::Object(map) => {
            for banned in ["anyOf", "oneOf", "allOf", "minimum", "maximum", "minLength", "maxLength", "format", "pattern", "default"] {
                assert!(!map.contains_key(banned), "{banned} in {node}");
            }
            if map.contains_key("properties") {
                assert_eq!(map["additionalProperties"], false, "{node}");
                let mut props: Vec<&str> = map["properties"].as_object().unwrap().keys().map(String::as_str).collect();
                let mut req: Vec<&str> = map["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
                props.sort();
                req.sort();
                assert_eq!(req, props, "{node}");
            }
            map.values().for_each(check_strict);
        }
        Value::Array(a) => a.iter().for_each(check_strict),
        _ => {}
    }
}

#[test]
fn openai_schema_is_strict_compatible() {
    let s = strict_schema(&Verdict::json_schema());
    check_strict(&s);
    assert_eq!(s["properties"]["correct"]["type"], json!(["boolean", "null"]));
    assert_eq!(s["properties"]["errorNature"]["type"], json!(["string", "null"]));
    assert!(s["properties"]["errorNature"]["enum"].as_array().unwrap().contains(&Value::Null));
    assert_eq!(s["properties"]["transcription"]["type"], json!(["object", "null"]));
    assert_eq!(s["properties"]["transcription"]["properties"]["kind"]["enum"], json!(["text", "code"]));
    // The shared (Anthropic) schema is untouched.
    assert!(Verdict::json_schema()["properties"]["correct"].get("anyOf").is_some());
}

fn quirky(base: &str, structured: Structured, token_param: TokenParam) -> OpenAiProvider {
    let q = Quirks { structured, token_param, ..Quirks::default() };
    provider(base).with_quirks(q)
}

fn text_req(schema: Option<Value>) -> TextRequest {
    TextRequest { system: "sys".into(), user: "u".into(), max_tokens: 50, json_schema: schema }
}

fn tiny_schema() -> Value {
    json!({ "type": "object", "additionalProperties": false, "required": ["a"], "properties": { "a": { "type": "integer" } } })
}

#[test]
fn json_object_mode_puts_the_schema_in_the_prompt() {
    let (base, seen) = stub(vec![reply_with(json!({ "content": "```json\n{\"a\": 1}\n```" }), "stop")]);
    let out =
        quirky(&base, Structured::JsonObject, TokenParam::MaxTokens).complete(&text_req(Some(tiny_schema()))).unwrap();
    assert_eq!(out, "{\"a\": 1}");
    let b = &seen.lock().unwrap()[0].body;
    assert_eq!(b["response_format"], json!({ "type": "json_object" }));
    assert_eq!(b["max_tokens"], 50);
    assert!(b.get("max_completion_tokens").is_none());
    let system = b["messages"][0]["content"].as_str().unwrap();
    assert!(system.starts_with("sys"));
    assert!(system.contains("JSON") && system.contains("\"required\""), "{system}");
}

#[test]
fn prompt_only_mode_sends_no_response_format_and_parses_loosely() {
    let wrapped = format!("Here you go:\n```\n{}\n```\nHope that helps.", verdict_json());
    let (base, seen) = stub(vec![reply_with(json!({ "content": wrapped }), "stop")]);
    let v = quirky(&base, Structured::PromptOnly, TokenParam::MaxTokens).recognize(&request()).unwrap();
    assert_eq!(v.latex, "x=2");
    let b = &seen.lock().unwrap()[0].body;
    assert!(b.get("response_format").is_none());
    assert_eq!(b["max_tokens"], 4096);
    assert!(b["messages"][0]["content"].as_str().unwrap().contains("\"latex\""));
    // Text without a schema is returned as is.
    let (base, seen) = stub(vec![reply_with(json!({ "content": "Plain {text}" }), "stop")]);
    let out = quirky(&base, Structured::PromptOnly, TokenParam::MaxTokens).complete(&text_req(None)).unwrap();
    assert_eq!(out, "Plain {text}");
    assert_eq!(seen.lock().unwrap()[0].body["messages"][0]["content"], "sys");
}

#[test]
fn json_schema_mode_with_max_tokens() {
    let (base, seen) = stub(vec![reply_with(json!({ "content": "{\"a\":1}" }), "stop")]);
    quirky(&base, Structured::JsonSchema, TokenParam::MaxTokens).complete(&text_req(Some(tiny_schema()))).unwrap();
    let b = &seen.lock().unwrap()[0].body;
    assert_eq!(b["response_format"]["type"], "json_schema");
    assert_eq!(b["max_tokens"], 50);
    assert!(b.get("max_completion_tokens").is_none());
    assert_eq!(b["messages"][0]["content"], "sys");
}

#[test]
fn chat_path_extra_headers_and_id() {
    let (base, seen) = stub(vec![reply_with(json!({ "content": "ok" }), "stop")]);
    let q = Quirks {
        chat_path: "/api/paas/v4/chat/completions",
        extra_headers: &[("X-Title", "Mate"), ("HTTP-Referer", "https://github.com/inalto/Mate")],
        ..Quirks::default()
    };
    let p = provider(&base).with_quirks(q).with_id("zai");
    assert_eq!(p.id(), "zai");
    p.complete(&text_req(None)).unwrap();
    let r = &seen.lock().unwrap()[0];
    assert_eq!(r.path, "/api/paas/v4/chat/completions");
    assert_eq!(r.header("x-title"), Some("Mate"));
    assert_eq!(r.header("http-referer"), Some("https://github.com/inalto/Mate"));
}

#[test]
fn no_authorization_header_without_a_key_and_no_double_v1() {
    let (base, seen) = stub(vec![reply_with(json!({ "content": "ok" }), "stop")]);
    OpenAiProvider::new(String::new(), "m".into(), format!("{base}/v1/")).complete(&text_req(None)).unwrap();
    let r = &seen.lock().unwrap()[0];
    assert_eq!(r.path, "/v1/chat/completions");
    assert_eq!(r.header("authorization"), None);
}

#[test]
fn model_list_parsers() {
    let openai = r#"{"object":"list","data":[{"id":"gpt-5","object":"model"},{"id":"gpt-5-mini"},{"id":"gpt-5"}]}"#;
    assert_eq!(parse_model_list(openai, false).unwrap(), ["gpt-5", "gpt-5-mini"]);
    let openrouter = r#"{"data":[
        {"id":"z/vision","architecture":{"input_modalities":["text","image"]}},
        {"id":"a/text","architecture":{"input_modalities":["text"]}},
        {"id":"b/unknown"},
        {"id":"a/vision","architecture":{"input_modalities":["image","text","file"]}}]}"#;
    assert_eq!(parse_model_list(openrouter, true).unwrap(), ["a/vision", "z/vision"]);
    assert_eq!(parse_model_list(openrouter, false).unwrap().len(), 4);
    let ollama = r#"{"models":[{"name":"qwen3-vl:8b","model":"qwen3-vl:8b"},{"name":"llama3.2:3b"}]}"#;
    assert_eq!(parse_model_list(ollama, false).unwrap(), ["llama3.2:3b", "qwen3-vl:8b"]);
    assert!(matches!(parse_model_list("<html>", false), Err(AiError::InvalidResponse(_))));
    assert!(matches!(parse_model_list(r#"{"error":"x"}"#, false), Err(AiError::InvalidResponse(_))));
}

#[test]
fn list_models_hits_the_models_path_with_headers() {
    let body = r#"{"data":[{"id":"b"},{"id":"a"}]}"#;
    let (base, seen) = stub(vec![(200, body.into())]);
    let q = Quirks { extra_headers: &[("X-Title", "Mate")], ..Quirks::default() };
    assert_eq!(provider(&base).with_quirks(q).list_models().unwrap(), ["a", "b"]);
    let r = &seen.lock().unwrap()[0];
    assert_eq!(r.path, "/v1/models");
    assert_eq!(r.header("authorization"), Some("Bearer sk-test-secret"));
    assert_eq!(r.header("x-title"), Some("Mate"));

    let tags = r#"{"models":[{"name":"qwen3-vl:8b"}]}"#;
    let (base, seen) = stub(vec![(200, tags.into())]);
    let q = Quirks { models_path: Some("/api/tags"), ..Quirks::default() };
    let p = OpenAiProvider::new(String::new(), "m".into(), base).with_quirks(q);
    assert_eq!(p.list_models().unwrap(), ["qwen3-vl:8b"]);
    assert_eq!(seen.lock().unwrap()[0].path, "/api/tags");

    let (base, _) = stub(vec![(401, r#"{"error":{"message":"bad key sk-test-secret"}}"#.into())]);
    let e = provider(&base).list_models().unwrap_err();
    assert!(matches!(e, AiError::Auth), "{e:?}");

    let q = Quirks { models_path: None, ..Quirks::default() };
    assert!(matches!(provider("http://127.0.0.1:1").with_quirks(q).list_models(), Err(AiError::Rejected(_))));
}

#[test]
fn factory_builds_quirky_providers_against_the_base_url() {
    let (base, seen) = stub(vec![reply_with(json!({ "content": "{\"a\":1}" }), "stop")]);
    let p = provider_for("ollama", "", String::new(), Some(&base));
    assert_eq!(p.id(), "ollama");
    assert_eq!(p.complete(&text_req(Some(tiny_schema()))).unwrap(), "{\"a\":1}");
    let r = &seen.lock().unwrap()[0];
    assert_eq!(r.path, "/v1/chat/completions");
    assert_eq!(r.body["model"], "qwen3-vl:8b");
    assert_eq!(r.body["response_format"]["type"], "json_schema");
    assert_eq!(r.header("authorization"), None);
}
