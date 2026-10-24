//! The AI services Mate can talk to, as one static table. The UI reads it over IPC
//! (`list_ai_providers`) so the list is never duplicated in TypeScript.

use serde::Serialize;

/// The request format a service speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    Anthropic,
    OpenAiCompat,
}

/// How a structured (JSON) answer is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Structured {
    /// `response_format: {type: "json_schema", strict: true}`.
    JsonSchema,
    /// `response_format: {type: "json_object"}`, schema in the system prompt.
    JsonObject,
    /// No `response_format`; schema in the system prompt and a tolerant parse of the reply.
    PromptOnly,
}

/// Which request field carries the output limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenParam {
    MaxTokens,
    MaxCompletionTokens,
}

/// Whether the service can read images (needed to check handwriting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Vision {
    Yes,
    DependsOnModel,
    No,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    Cloud,
    Local,
    Custom,
}

#[derive(Debug)]
pub struct ProviderSpec {
    /// The `settings.aiProvider` value and the keychain account.
    pub id: &'static str,
    pub label: &'static str,
    pub wire: Wire,
    /// Default address; overridable only when `editable_base_url`. Empty for `custom`.
    pub base_url: &'static str,
    pub chat_path: &'static str,
    pub models_path: Option<&'static str>,
    /// Only models that accept images are listed (OpenRouter).
    pub models_vision_only: bool,
    pub default_model: &'static str,
    pub needs_key: bool,
    pub local: bool,
    pub editable_base_url: bool,
    pub vision: Vision,
    pub structured: Structured,
    pub token_param: TokenParam,
    pub extra_headers: &'static [(&'static str, &'static str)],
    /// Where to get a key; empty when none is needed.
    pub key_url: &'static str,
    pub cost: &'static str,
    pub privacy: &'static str,
}

impl ProviderSpec {
    pub fn group(&self) -> Group {
        if self.local {
            Group::Local
        } else if self.id == "custom" {
            Group::Custom
        } else {
            Group::Cloud
        }
    }
}

const CHAT: &str = "/v1/chat/completions";
const MODELS: Option<&str> = Some("/v1/models");

/// An OpenAI-compatible cloud service with the common defaults.
const fn cloud(id: &'static str, label: &'static str, base_url: &'static str, default_model: &'static str) -> ProviderSpec {
    ProviderSpec {
        id,
        label,
        wire: Wire::OpenAiCompat,
        base_url,
        chat_path: CHAT,
        models_path: MODELS,
        models_vision_only: false,
        default_model,
        needs_key: true,
        local: false,
        editable_base_url: false,
        vision: Vision::DependsOnModel,
        structured: Structured::JsonSchema,
        token_param: TokenParam::MaxTokens,
        extra_headers: &[],
        key_url: "",
        cost: "Paid",
        privacy: "",
    }
}

/// A program on this computer: no key, editable address, nothing leaves the machine.
const fn local(id: &'static str, label: &'static str, base_url: &'static str, default_model: &'static str) -> ProviderSpec {
    ProviderSpec {
        needs_key: false,
        local: true,
        editable_base_url: true,
        cost: "Free (runs on this computer)",
        privacy: "Nothing leaves this computer.",
        ..cloud(id, label, base_url, default_model)
    }
}

static CATALOG: [ProviderSpec; 14] = [
    ProviderSpec {
        wire: Wire::Anthropic,
        vision: Vision::Yes,
        key_url: "https://console.anthropic.com/settings/keys",
        privacy: "Checked notes are sent to Anthropic.",
        ..cloud("anthropic", "Anthropic", "https://api.anthropic.com", "claude-opus-5-5")
    },
    ProviderSpec {
        vision: Vision::Yes,
        token_param: TokenParam::MaxCompletionTokens,
        key_url: "https://platform.openai.com/api-keys",
        privacy: "Checked notes are sent to OpenAI.",
        ..cloud("openai", "OpenAI", "https://api.openai.com", "gpt-5")
    },
    ProviderSpec {
        models_vision_only: true,
        extra_headers: &[("HTTP-Referer", "https://github.com/inalto/Mate"), ("X-Title", "Mate")],
        key_url: "https://openrouter.ai/keys",
        cost: "Paid; some models are free",
        privacy: "Checked notes are sent to OpenRouter and the model's maker.",
        ..cloud("openrouter", "OpenRouter", "https://openrouter.ai/api", "google/gemini-2.5-flash")
    },
    ProviderSpec {
        chat_path: "/v1beta/openai/chat/completions",
        models_path: Some("/v1beta/openai/models"),
        vision: Vision::Yes,
        key_url: "https://aistudio.google.com/apikey",
        cost: "Free tier, then paid",
        privacy: "Checked notes are sent to Google.",
        ..cloud("gemini", "Google Gemini", "https://generativelanguage.googleapis.com", "gemini-2.5-flash")
    },
    ProviderSpec {
        token_param: TokenParam::MaxCompletionTokens,
        key_url: "https://console.groq.com/keys",
        cost: "Free tier, then paid",
        privacy: "Checked notes are sent to Groq.",
        ..cloud("groq", "Groq", "https://api.groq.com/openai", "qwen/qwen3.8-27b")
    },
    ProviderSpec {
        vision: Vision::Yes,
        structured: Structured::JsonObject,
        key_url: "https://console.mistral.ai/api-keys",
        cost: "Free tier, then paid",
        privacy: "Checked notes are sent to Mistral.",
        ..cloud("mistral", "Mistral", "https://api.mistral.ai", "mistral-small-latest")
    },
    ProviderSpec {
        vision: Vision::No,
        structured: Structured::JsonObject,
        key_url: "https://platform.deepseek.com/api_keys",
        cost: "Paid, low cost",
        privacy: "Text is sent to DeepSeek.",
        ..cloud("deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-flash")
    },
    ProviderSpec {
        chat_path: "/api/paas/v4/chat/completions",
        models_path: None,
        structured: Structured::PromptOnly,
        key_url: "https://z.ai/manage-apikey/apikey-list",
        privacy: "Checked notes are sent to Z.ai.",
        ..cloud("zai", "Z.ai (GLM)", "https://api.z.ai", "glm-4.6v")
    },
    ProviderSpec {
        structured: Structured::JsonObject,
        key_url: "https://platform.moonshot.ai/console/api-keys",
        privacy: "Checked notes are sent to Moonshot.",
        ..cloud("kimi", "Moonshot Kimi", "https://api.moonshot.ai", "kimi-k2.6")
    },
    ProviderSpec {
        vision: Vision::Yes,
        key_url: "https://console.x.ai",
        privacy: "Checked notes are sent to xAI.",
        ..cloud("xai", "xAI Grok", "https://api.x.ai", "grok-4.7")
    },
    ProviderSpec {
        key_url: "https://api.together.ai/settings/api-keys",
        privacy: "Checked notes are sent to Together.",
        ..cloud("together", "Together", "https://api.together.ai", "Qwen/Qwen3.5-9B")
    },
    ProviderSpec { models_path: Some("/api/tags"), ..local("ollama", "Ollama", "http://localhost:11434", "qwen3-vl:8b") },
    local("lmstudio", "LM Studio", "http://localhost:1234", ""),
    ProviderSpec {
        needs_key: false,
        editable_base_url: true,
        structured: Structured::JsonObject,
        cost: "Depends on the service",
        privacy: "Checked notes are sent to the address you enter.",
        ..cloud("custom", "Custom (OpenAI-compatible)", "", "")
    },
];

pub fn catalog() -> &'static [ProviderSpec] {
    &CATALOG
}

pub fn spec(id: &str) -> Option<&'static ProviderSpec> {
    CATALOG.iter().find(|s| s.id == id)
}

/// The spec for a settings value; unknown ids fall back to Anthropic.
pub fn spec_or_default(id: &str) -> &'static ProviderSpec {
    spec(id).unwrap_or(&CATALOG[0])
}

/// Shown when an address is neither `https://` nor a local `http://` one.
pub const BAD_ADDRESS: &str = "Use an https:// address, or a local address such as http://localhost:11434.";

/// The address to use: `override_url` (trimmed, without a trailing `/`) when the provider allows
/// it and it is not empty, else the catalog default. An override must be `https://`, or `http://`
/// on a local host (see [`is_local_host`]); otherwise the error is [`BAD_ADDRESS`].
pub fn effective_base_url(id: &str, override_url: &str) -> Result<String, String> {
    let s = spec_or_default(id);
    let o = override_url.trim().trim_end_matches('/');
    if s.editable_base_url && !o.is_empty() {
        check_address(o)?;
        Ok(o.to_string())
    } else {
        Ok(s.base_url.to_string())
    }
}

fn check_address(url: &str) -> Result<(), String> {
    match url::Url::parse(url) {
        Ok(u) if u.scheme() == "https" && u.host().is_some() => Ok(()),
        Ok(u) if u.scheme() == "http" && is_local_host(url) => Ok(()),
        _ => Err(BAD_ADDRESS.to_string()),
    }
}

/// True when `url` names this computer or the local network: `localhost`, `*.localhost`, a
/// loopback address (`127.0.0.0/8`, `::1`) or a private IPv4 range (`10/8`, `172.16/12`,
/// `192.168/16`). The settings screen mirrors this rule.
pub fn is_local_host(url: &str) -> bool {
    use std::net::IpAddr;
    let Ok(u) = url::Url::parse(url.trim()) else { return false };
    match u.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback() || ip.is_private(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}
