//! The provider catalog, base URL resolution and the provider factory. No network.

use std::collections::HashSet;

use mate_core::ai::catalog::{Group, Structured, TokenParam, Vision, Wire, catalog, effective_base_url, spec};
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
    assert_eq!(effective_base_url("ollama", ""), "http://localhost:11434");
    assert_eq!(effective_base_url("ollama", " http://box:11434/ "), "http://box:11434");
    assert_eq!(effective_base_url("custom", "https://llm.example.org/v1"), "https://llm.example.org/v1");
    assert_eq!(effective_base_url("custom", ""), "");
    // Cloud services keep their own address.
    assert_eq!(effective_base_url("openai", "http://evil.example"), "https://api.openai.com");
    // Unknown ids fall back to Anthropic.
    assert_eq!(effective_base_url("acme", ""), "https://api.anthropic.com");
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
}
