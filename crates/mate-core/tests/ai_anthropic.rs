//! The Anthropic provider against a local stub HTTP server. Never touches the real network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine;
use mate_core::ai::anthropic::AnthropicProvider;
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
        "description": "x equals two",
        "latex": "x=2",
        "correct": false,
        "domain": "Algebra",
        "errorNature": "procedural",
        "hint": "Check the subtraction.",
        "explanation": "Subtracting 1 from both sides gives a different value.",
        "nextSteps": "Redo the last step.",
        "focusSpan": "2",
        "illegible": false,
        "transcription": null
    })
}

fn ok_reply(v: &Value) -> (u16, String) {
    let body = json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "stop_reason": "end_turn",
        "content": [
            { "type": "thinking", "thinking": "", "signature": "s" },
            { "type": "text", "text": v.to_string() }
        ]
    });
    (200, body.to_string())
}

fn request() -> RecognizeRequest {
    RecognizeRequest {
        image_png: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
        context: vec![ContextLine { content: "x+1=3".into(), is_new: false }],
        difficulty: "intermediate".into(),
        practice: None,
    }
}

fn provider(base: &str) -> AnthropicProvider {
    AnthropicProvider::new("sk-test-secret".into(), "claude-opus-5-5".into(), base.into())
        .with_backoff(Duration::from_millis(10))
}

#[test]
fn anthropic_request_has_image_block_and_schema() {
    let (base, seen) = stub(vec![ok_reply(&verdict_json())]);
    provider(&base).recognize(&request()).unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let r = &seen[0];
    assert_eq!(r.path, "/v1/messages");
    assert_eq!(r.header("x-api-key"), Some("sk-test-secret"));
    assert_eq!(r.header("anthropic-version"), Some("2023-06-01"));
    assert!(r.header("content-type").unwrap().starts_with("application/json"));
    let b = &r.body;
    assert_eq!(b["model"], "claude-opus-5-5");
    assert_eq!(b["max_tokens"], 4096);
    assert_eq!(b["thinking"], json!({ "type": "adaptive" }));
    assert_eq!(b["output_config"]["effort"], "medium");
    assert_eq!(b["output_config"]["format"]["type"], "json_schema");
    assert_eq!(b["output_config"]["format"]["schema"], Verdict::json_schema());
    assert!(b["system"].as_str().unwrap().contains("Never solve the problem"));
    let msgs = b["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["role"], "user");
    let content = msgs[0]["content"].as_array().unwrap();
    assert_eq!(content[0]["type"], "text");
    assert!(content[0]["text"].as_str().unwrap().contains("x+1=3"));
    let img = &content[1];
    assert_eq!(img["type"], "image");
    assert_eq!(img["source"]["type"], "base64");
    assert_eq!(img["source"]["media_type"], "image/png");
    let data = base64::engine::general_purpose::STANDARD.decode(img["source"]["data"].as_str().unwrap()).unwrap();
    assert_eq!(data, request().image_png);
}

#[test]
fn anthropic_parses_verdict() {
    let (base, _) = stub(vec![ok_reply(&verdict_json())]);
    let v = provider(&base).recognize(&request()).unwrap();
    assert_eq!(v.latex, "x=2");
    assert_eq!(v.correct, Some(false));
    // "Algebra" (capitalised by the model) still maps to the enum.
    assert_eq!(v.code, VerdictCode::Algebra);
    assert_eq!(v.kind, VerdictKind::Math);
    assert_eq!(v.hint.as_deref(), Some("Check the subtraction."));
}

#[test]
fn anthropic_maps_401_to_auth() {
    let err = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
    let (base, seen) = stub(vec![(401, err.into()), ok_reply(&verdict_json())]);
    let e = provider(&base).recognize(&request()).unwrap_err();
    assert!(matches!(e, AiError::Auth), "{e:?}");
    // Not retried, and the key never appears in the error.
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(!e.to_string().contains("sk-test"));
}

#[test]
fn anthropic_retries_server_errors_then_gives_up() {
    let busy = r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#;
    let (base, seen) = stub(vec![(529, busy.into()), (500, busy.into()), ok_reply(&verdict_json())]);
    assert!(provider(&base).recognize(&request()).is_ok());
    assert_eq!(seen.lock().unwrap().len(), 3);

    let (base, seen) = stub(vec![(429, busy.into()), (429, busy.into()), (429, busy.into()), (429, busy.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::RateLimited)));
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[test]
fn anthropic_maps_400_to_rejected_and_bad_json_to_invalid() {
    let bad = r#"{"type":"error","error":{"type":"invalid_request_error","message":"image too large"}}"#;
    let (base, _) = stub(vec![(400, bad.into())]);
    match provider(&base).recognize(&request()) {
        Err(AiError::Rejected(m)) => assert!(m.contains("image too large")),
        other => panic!("{other:?}"),
    }
    let body = json!({ "content": [{ "type": "text", "text": "not json" }], "stop_reason": "end_turn" });
    let (base, _) = stub(vec![(200, body.to_string())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::InvalidResponse(_))));
}

#[test]
fn anthropic_network_failure_is_network_error() {
    // Bind then drop a listener so the port refuses connections.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = provider(&format!("http://127.0.0.1:{port}")).recognize(&request()).unwrap_err();
    assert!(matches!(e, AiError::Network(_)), "{e:?}");
}

#[test]
fn anthropic_complete_returns_text() {
    let body = json!({ "content": [{ "type": "text", "text": "A short summary." }], "stop_reason": "end_turn" });
    let (base, seen) = stub(vec![(200, body.to_string())]);
    let out = provider(&base)
        .complete(&TextRequest { system: "sys".into(), user: "hello".into(), max_tokens: 300, json_schema: None })
        .unwrap();
    assert_eq!(out, "A short summary.");
    let b = &seen.lock().unwrap()[0].body;
    assert_eq!(b["system"], "sys");
    assert_eq!(b["max_tokens"], 300);
    assert_eq!(b["messages"][0]["content"], "hello");
    assert!(b["output_config"].get("format").is_none());
}

#[test]
fn anthropic_debug_hides_the_key() {
    let p = AnthropicProvider::new("sk-test-secret".into(), "m".into(), "http://x".into());
    assert!(!format!("{p:?}").contains("sk-test-secret"));
}

#[test]
fn anthropic_refusal_and_cut_off_are_final() {
    for (stop, want) in [("refusal", "refused"), ("max_tokens", "truncated")] {
        let body = json!({ "content": [{ "type": "text", "text": "{" }], "stop_reason": stop });
        let (base, seen) = stub(vec![(200, body.to_string()), ok_reply(&verdict_json())]);
        let e = provider(&base).recognize(&request()).unwrap_err();
        match want {
            "refused" => assert!(matches!(e, AiError::Refused), "{e:?}"),
            _ => assert!(matches!(e, AiError::Truncated), "{e:?}"),
        }
        assert_eq!(seen.lock().unwrap().len(), 1, "{stop} must not be retried");
    }
}

#[test]
fn anthropic_maps_billing_and_unknown_model() {
    let err = r#"{"type":"error","error":{"type":"x","message":"m"}}"#;
    let (base, seen) = stub(vec![(402, err.into()), ok_reply(&verdict_json())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::Billing)));
    assert_eq!(seen.lock().unwrap().len(), 1);
    let (base, _) = stub(vec![(404, err.into())]);
    assert!(matches!(provider(&base).recognize(&request()), Err(AiError::UnknownModel)));
}

#[test]
fn anthropic_retries_408() {
    let (base, seen) = stub(vec![(408, "{}".into()), ok_reply(&verdict_json())]);
    assert!(provider(&base).recognize(&request()).is_ok());
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[test]
fn anthropic_lists_models_with_version_header() {
    let body = r#"{"data":[{"id":"claude-opus-5-5","type":"model"},{"id":"claude-haiku-5"}],"has_more":false}"#;
    let (base, seen) = stub(vec![(200, body.into())]);
    let p = AnthropicProvider::new("sk-ant-secret".into(), "m".into(), base);
    assert_eq!(p.list_models().unwrap(), ["claude-haiku-5", "claude-opus-5-5"]);
    let r = &seen.lock().unwrap()[0];
    assert!(r.path.starts_with("/v1/models"), "{}", r.path);
    assert_eq!(r.header("x-api-key"), Some("sk-ant-secret"));
    assert_eq!(r.header("anthropic-version"), Some("2023-06-01"));

    let (base, _) = stub(vec![(401, r#"{"error":{"message":"invalid x-api-key"}}"#.into())]);
    let e = AnthropicProvider::new("bad".into(), "m".into(), base).list_models().unwrap_err();
    assert!(matches!(e, AiError::Auth), "{e:?}");
}
