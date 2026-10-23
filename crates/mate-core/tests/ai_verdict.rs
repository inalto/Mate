use mate_core::ai::keystore::{KeyStore, MemoryStore};
use mate_core::ai::mock::MockProvider;
use mate_core::ai::provider::{AiError, ContextLine, Provider, RecognizeRequest, TextRequest};
use mate_core::ai::verdict::{Domain, ErrorNature, Verdict, VerdictCode, VerdictKind};
use mate_core::ai::{default_model, provider_for};
use serde_json::{Value, json};

fn parse(v: Value) -> Verdict {
    let mut verdict: Verdict = serde_json::from_value(v).unwrap();
    verdict.validate();
    verdict
}

fn base() -> Value {
    json!({
        "description": "x squared plus one",
        "latex": "x^2+1",
        "correct": null,
        "domain": "algebra",
        "errorNature": null,
        "hint": null,
        "explanation": null,
        "nextSteps": null,
        "focusSpan": null,
        "illegible": false,
        "transcription": null
    })
}

fn with(patch: Value) -> Value {
    let mut v = base();
    for (k, val) in patch.as_object().unwrap() {
        v[k] = val.clone();
    }
    v
}

#[test]
fn verdict_derives_code() {
    assert_eq!(parse(base()).code, VerdictCode::Incomplete);
    assert_eq!(parse(with(json!({"correct": true}))).code, VerdictCode::Ok);
    let cases = [
        ("arithmetic", VerdictCode::Arithmetic),
        ("algebra", VerdictCode::Algebra),
        ("calculus", VerdictCode::Calculus),
        ("geometry", VerdictCode::Conceptual),
        ("physics", VerdictCode::Conceptual),
    ];
    for (domain, code) in cases {
        let v = parse(with(json!({"correct": false, "domain": domain, "errorNature": "slip"})));
        assert_eq!(v.code, code, "{domain}");
    }
    let v = parse(with(json!({"correct": false, "domain": "calculus", "errorNature": "conceptual"})));
    assert_eq!(v.code, VerdictCode::Conceptual);

    // kind: math when latex is present, diagram otherwise.
    assert_eq!(parse(base()).kind, VerdictKind::Math);
    assert_eq!(parse(with(json!({"latex": "  "}))).kind, VerdictKind::Diagram);

    // Derived fields go to TS in camelCase / SCREAMING codes.
    let out = serde_json::to_value(parse(with(json!({"correct": false, "errorNature": "procedural"})))).unwrap();
    assert_eq!(out["code"], "ALGEBRA");
    assert_eq!(out["kind"], "math");
    assert_eq!(out["errorNature"], "procedural");
    assert!(out.get("nextSteps").is_some());
}

#[test]
fn verdict_coerces_error_nature() {
    // error_nature only survives when the work is wrong.
    let v = parse(with(json!({"correct": true, "errorNature": "slip"})));
    assert_eq!(v.error_nature, None);
    let v = parse(with(json!({"correct": null, "errorNature": "conceptual"})));
    assert_eq!(v.error_nature, None);
    let v = parse(with(json!({"correct": false, "errorNature": "slip"})));
    assert_eq!(v.error_nature, Some(ErrorNature::Slip));

    // Unknown enum strings fall back instead of failing the parse.
    let v = parse(with(json!({"correct": false, "domain": "topology", "errorNature": "typo"})));
    assert_eq!(v.domain, Domain::Other);
    assert_eq!(v.error_nature, None);
    assert_eq!(v.code, VerdictCode::Conceptual);
    let v = parse(with(json!({"transcription": {"kind": "poem", "text": "hi"}})));
    assert_eq!(v.transcription.unwrap().kind, mate_core::ai::verdict::TranscriptionKind::Text);

    // Missing optional fields default.
    let v = parse(json!({"description": "d", "latex": "", "domain": "other", "illegible": true}));
    assert!(v.illegible);
    assert_eq!(v.kind, VerdictKind::Diagram);
}

#[test]
fn verdict_json_schema_is_strict() {
    fn check(node: &Value) {
        match node {
            Value::Object(map) => {
                assert!(!map.contains_key("minimum") && !map.contains_key("maxLength"));
                if map.get("type") == Some(&json!("object")) {
                    assert_eq!(map["additionalProperties"], json!(false));
                    let props: Vec<&String> = map["properties"].as_object().unwrap().keys().collect();
                    let mut req: Vec<&str> =
                        map["required"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
                    req.sort();
                    let mut props: Vec<&str> = props.iter().map(|s| s.as_str()).collect();
                    props.sort();
                    assert_eq!(props, req);
                }
                map.values().for_each(check);
            }
            Value::Array(items) => items.iter().for_each(check),
            _ => {}
        }
    }
    let schema = Verdict::json_schema();
    check(&schema);
    let props = schema["properties"].as_object().unwrap();
    assert_eq!(props.len(), 11);
    assert!(props.contains_key("errorNature") && props.contains_key("focusSpan"));
    assert!(!props.contains_key("code") && !props.contains_key("kind"));
}

fn request() -> RecognizeRequest {
    RecognizeRequest {
        image_png: vec![1, 2, 3],
        context: vec![ContextLine { content: "x=1".into(), is_new: true }],
        difficulty: "standard".into(),
        practice: None,
    }
}

#[test]
fn mock_provider_scripts_results() {
    let ok = parse(with(json!({"correct": true})));
    let mock = MockProvider::new(vec![Ok(ok.clone()), Err(AiError::RateLimited)]);
    assert_eq!(mock.id(), "mock");
    assert_eq!(mock.recognize(&request()).unwrap(), ok);
    assert!(matches!(mock.recognize(&request()), Err(AiError::RateLimited)));
    // Exhausted scripts are an error, never a panic.
    assert!(matches!(mock.recognize(&request()), Err(AiError::InvalidResponse(_))));
    assert_eq!(mock.requests().len(), 3);
    assert_eq!(mock.requests()[0].context[0].content, "x=1");

    let text = MockProvider::new(vec![]).with_text(vec![Ok("pong".into())]);
    let req = TextRequest { system: "s".into(), user: "ping".into(), max_tokens: 1, json_schema: None };
    assert_eq!(text.complete(&req).unwrap(), "pong");
    assert!(text.complete(&req).is_err());
}

#[test]
fn provider_factory_builds_known_providers() {
    assert_eq!(default_model("anthropic"), "claude-opus-5-5");
    assert_eq!(default_model("openai"), "gpt-5");
    // Construction only: no request is sent here.
    assert_eq!(provider_for("anthropic", "", "k".into()).id(), "anthropic");
    let p = provider_for("openai", "", "k".into());
    assert_eq!(p.id(), "openai");
    assert!(matches!(p.recognize(&request()), Err(AiError::Disabled)));
    assert_eq!(provider_for("mock", "", String::new()).id(), "mock");
}

#[test]
fn ai_errors_read_as_sentences() {
    for e in [
        AiError::Auth,
        AiError::RateLimited,
        AiError::Network("timeout".into()),
        AiError::InvalidResponse("bad json".into()),
        AiError::Disabled,
        AiError::Rejected("image too large".into()),
        AiError::Billing,
        AiError::UnknownModel,
        AiError::Refused,
        AiError::Truncated,
    ] {
        let msg = e.to_string();
        assert!(msg.len() > 10 && msg.ends_with('.'), "{msg}");
        assert!(!msg.contains("Derive"));
    }
}

#[test]
fn memory_store_round_trips() {
    let store = MemoryStore::default();
    assert_eq!(store.get("anthropic").unwrap(), None);
    store.set("anthropic", "sk-1").unwrap();
    assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("sk-1"));
    assert_eq!(store.get("openai").unwrap(), None);
    store.delete("anthropic").unwrap();
    store.delete("anthropic").unwrap(); // idempotent
    assert_eq!(store.get("anthropic").unwrap(), None);
}
