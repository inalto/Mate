//! The provider catalog, base URL resolution and the provider factory. No network.

use std::collections::HashSet;

use mate_core::ai::catalog::{
    Group, Structured, TokenParam, Vision, Wire, catalog, effective_base_url, is_local_host, spec,
};
use mate_core::ai::openai::extract_json_object;
use mate_core::ai::{default_model, is_known_provider, provider_for};

#[test]
fn catalog_ids_are_unique_and_complete() {
    let ids: Vec<&str> = catalog().iter().map(|s| s.id).collect();
    let unique: HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(unique.len(), ids.len(), "duplicate ids in {ids:?}");
    assert_eq!(
        ids,
        [
            "anthropic", "openai", "openrouter", "gemini", "groq", "mistral", "deepseek", "zai", "kimi", "xai",
            "together", "ollama", "lmstudio", "custom"
        ]
    );
    for id in &ids {
        assert!(is_known_provider(id), "{id}");
    }
    assert!(!is_known_provider("mock"));
    assert!(!is_known_provider("acme"));
}

#[test]
fn catalog_invariants() {
    for s in catalog() {
        assert!(!s.label.is_empty(), "{}", s.id);
        assert!(!s.cost.is_empty() && !s.privacy.is_empty(), "{}", s.id);
        assert!(s.chat_path.starts_with('/'), "{}", s.id);
        if s.local {
            assert!(!s.needs_key, "{} is local but needs a key", s.id);
            assert!(s.editable_base_url, "{}", s.id);
            assert_eq!(s.key_url, "", "{}", s.id);
            assert_eq!(s.group(), Group::Local);
        }
        if s.id != "custom" {
            assert!(s.base_url.starts_with("http"), "{} has no base URL", s.id);
        }
        if s.needs_key {
            assert!(s.key_url.starts_with("https://"), "{}", s.id);
            assert_eq!(s.group(), Group::Cloud);
        }
        if !matches!(s.id, "lmstudio" | "custom") {
            assert!(!s.default_model.is_empty(), "{} has no default model", s.id);
        }
        assert_eq!(default_model(s.id), s.default_model);
    }
}

#[test]
fn catalog_specific_entries() {
    let openai = spec("openai").unwrap();
    assert_eq!(openai.wire, Wire::OpenAiCompat);
    assert_eq!(openai.token_param, TokenParam::MaxCompletionTokens);
    assert_eq!(openai.structured, Structured::JsonSchema);
    assert_eq!(spec("anthropic").unwrap().wire, Wire::Anthropic);
    assert_eq!(spec("deepseek").unwrap().vision, Vision::No);
    assert_eq!(spec("zai").unwrap().structured, Structured::PromptOnly);
    assert_eq!(spec("zai").unwrap().chat_path, "/api/paas/v4/chat/completions");
    assert!(spec("zai").unwrap().models_path.is_none());
    assert_eq!(spec("ollama").unwrap().models_path, Some("/api/tags"));
    assert_eq!(spec("groq").unwrap().token_param, TokenParam::MaxCompletionTokens);
    let or = spec("openrouter").unwrap();
    assert!(or.extra_headers.contains(&("X-Title", "Mate")));
    let custom = spec("custom").unwrap();
    assert_eq!(custom.group(), Group::Custom);
    assert!(!custom.needs_key && !custom.local && custom.editable_base_url);
    assert_eq!(custom.vision, Vision::DependsOnModel);
    assert!(spec("mock").is_none());
}

#[test]
fn base_url_override_only_where_editable() {
    let eff = |id: &str, o: &str| effective_base_url(id, o).unwrap();
    assert_eq!(eff("ollama", ""), "http://localhost:11434");
    assert_eq!(eff("ollama", " http://192.168.1.20:11434/ "), "http://192.168.1.20:11434");
    assert_eq!(eff("custom", "https://llm.example.org/v1"), "https://llm.example.org/v1");
    assert_eq!(eff("custom", ""), "");
    // Cloud services keep their own address.
    assert_eq!(eff("openai", "http://evil.example"), "https://api.openai.com");
    // Unknown ids fall back to Anthropic.
    assert_eq!(eff("acme", ""), "https://api.anthropic.com");
}

#[test]
fn factory_uses_catalog_ids() {
    for s in catalog() {
        assert_eq!(provider_for(s.id, "", String::new(), None).id(), s.id);
    }
    assert_eq!(provider_for("acme", "", "k".into(), None).id(), "anthropic");
    assert_eq!(provider_for("mock", "", String::new(), None).id(), "mock");
}

#[test]
fn tolerant_json_extraction() {
    assert_eq!(extract_json_object(r#"{"a":1}"#), Some(r#"{"a":1}"#));
    assert_eq!(extract_json_object("```json\n{\"a\": {\"b\": 2}}\n```"), Some("{\"a\": {\"b\": 2}}"));
    assert_eq!(extract_json_object("Sure! {\"a\":\"}{\"} trailing {\"b\":1}"), Some("{\"a\":\"}{\"}"));
    assert_eq!(extract_json_object(r#"{"a":"quote \" and brace }"}"#), Some(r#"{"a":"quote \" and brace }"}"#));
    assert_eq!(extract_json_object("<think>maybe {x}</think>\n{\"ok\":true}"), Some("{\"ok\":true}"));
    assert_eq!(extract_json_object("no json here"), None);
    assert_eq!(extract_json_object("{\"open\": 1"), None);
    // Braces in prose (LaTeX) before the object are skipped.
    assert_eq!(extract_json_object("The answer is $\\frac{1}{2}$.\n{\"a\":1}"), Some("{\"a\":1}"));
    assert_eq!(extract_json_object("set {x | x > 0} then ```{\"b\": [1]}```"), Some("{\"b\": [1]}"));
    assert_eq!(extract_json_object("{not json} {also not}"), None);
    // A balanced block that is not an object at the top level is not returned.
    assert_eq!(extract_json_object("{1}{\"k\":{\"n\":null}}"), Some("{\"k\":{\"n\":null}}"));
}

#[test]
fn base_url_must_be_https_or_local() {
    const BAD: &str = "Use an https:// address, or a local address such as http://localhost:11434.";
    for ok in [
        "http://localhost:11434",
        "http://127.0.0.1:1234/v1",
        "http://[::1]:8080",
        "http://gpu.localhost:11434",
        "http://10.0.0.5:11434",
        "http://172.16.3.4",
        "http://172.31.255.255",
        "http://192.168.1.20:11434",
        "https://llm.example.org/v1",
        "HTTPS://LLM.EXAMPLE.ORG",
    ] {
        assert!(effective_base_url("custom", ok).is_ok(), "{ok}");
    }
    for bad in [
        "http://llm.example.org",
        "http://172.32.0.1",
        "http://8.8.8.8",
        "ftp://localhost",
        "localhost:11434",
        "not a url",
        "http://localhost.evil.com",
    ] {
        assert_eq!(effective_base_url("custom", bad).unwrap_err(), BAD, "{bad}");
        assert_eq!(effective_base_url("ollama", bad).unwrap_err(), BAD, "{bad}");
    }
}

#[test]
fn local_host_rule() {
    assert!(is_local_host("http://localhost:11434"));
    assert!(is_local_host("http://LOCALHOST"));
    assert!(is_local_host("https://127.0.0.1"));
    assert!(is_local_host("http://[::1]:1"));
    assert!(is_local_host("http://box.localhost"));
    assert!(is_local_host("http://10.1.2.3"));
    assert!(is_local_host("http://172.20.0.1"));
    assert!(is_local_host("http://192.168.0.2"));
    assert!(!is_local_host("http://172.15.0.1"));
    assert!(!is_local_host("https://api.openai.com"));
    assert!(!is_local_host("http://mylocalhost"));
    assert!(!is_local_host(""));
    assert!(!is_local_host("garbage"));
}

#[test]
fn factory_refuses_a_bad_address_without_network() {
    use mate_core::ai::provider::{AiError, TextRequest};
    let p = provider_for("custom", "m", String::new(), Some("http://llm.example.org"));
    assert_eq!(p.id(), "custom");
    let req = TextRequest { system: String::new(), user: "hi".into(), max_tokens: 4, json_schema: None };
    let e = p.complete(&req).unwrap_err();
    assert!(matches!(e, AiError::BadAddress), "{e:?}");
    assert_eq!(e.to_string(), "Use an https:// address, or a local address such as http://localhost:11434.");
    assert!(matches!(p.list_models(), Err(AiError::BadAddress)));
}
