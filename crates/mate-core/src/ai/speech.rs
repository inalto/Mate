//! Speech to text for dictation: a small catalog of services that speak OpenAI's
//! `POST /audio/transcriptions` multipart form, and one blocking call that sends a recording.
//!
//! Callers check `settings.speechConsent` and the key before calling [`transcribe`]; the key is
//! sent only in the `Authorization: Bearer` header (not at all when empty) and never logged.

use std::thread;
use std::time::Duration;

use reqwest::blocking::multipart::{Form, Part};
use serde_json::Value;

use super::catalog::{BAD_ADDRESS, is_local_host};
use super::provider::AiError;

/// One recording can take a while to upload and transcribe.
const TIMEOUT: Duration = Duration::from_secs(120);
/// A program on this computer or network may run on a CPU: up to 5 minutes for a long recording.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(300);
/// Wait before the single retry after a 429 or 5xx (as the tutor's OpenAI client).
const RETRY_BACKOFF: Duration = Duration::from_millis(800);

/// The `InvalidResponse` detail of a reply that holds no text (silence, or nothing recognised).
pub const NO_TEXT: &str = "no text was recognised";

/// The request timeout for an address: longer for a local server.
pub fn timeout_for(base: &str) -> Duration {
    if is_local_host(base) { LOCAL_TIMEOUT } else { TIMEOUT }
}

/// `ms` milliseconds of silence as a 16 kHz, 16-bit mono WAV file (the settings' test call).
pub fn silent_wav(ms: u32) -> Vec<u8> {
    const RATE: u32 = 16_000;
    let data_len = RATE * ms / 1000 * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.resize(44 + data_len as usize, 0);
    out
}

/// Largest recording sent (OpenAI's own limit).
pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug)]
pub struct SpeechSpec {
    /// The `settings.speechProvider` value; the keychain account is `speech:<id>`.
    pub id: &'static str,
    pub label: &'static str,
    /// Up to and including the version segment (`…/v1`); `/audio/transcriptions` is appended.
    /// Empty for `custom`.
    pub default_base_url: &'static str,
    pub default_model: &'static str,
    pub needs_key: bool,
    /// Where to get a key; empty when none is needed.
    pub key_url: &'static str,
    /// The address setting is used (local and custom only).
    pub editable_base_url: bool,
    /// A program on this computer (no key, nothing leaves the machine by default).
    pub local: bool,
}

static CATALOG: [SpeechSpec; 5] = [
    SpeechSpec {
        id: "openai",
        label: "OpenAI",
        default_base_url: "https://api.openai.com/v1",
        default_model: "gpt-4o-mini-transcribe",
        needs_key: true,
        key_url: "https://platform.openai.com/api-keys",
        editable_base_url: false,
        local: false,
    },
    SpeechSpec {
        id: "groq",
        label: "Groq",
        default_base_url: "https://api.groq.com/openai/v1",
        default_model: "whisper-large-v3-turbo",
        needs_key: true,
        key_url: "https://console.groq.com/keys",
        editable_base_url: false,
        local: false,
    },
    SpeechSpec {
        id: "mistral",
        label: "Mistral",
        default_base_url: "https://api.mistral.ai/v1",
        default_model: "voxtral-mini-latest",
        needs_key: true,
        key_url: "https://console.mistral.ai/api-keys",
        editable_base_url: false,
        local: false,
    },
    SpeechSpec {
        id: "local",
        label: "Local server (OpenAI-compatible)",
        default_base_url: "http://127.0.0.1:8000/v1",
        default_model: "whisper-1",
        needs_key: false,
        key_url: "",
        editable_base_url: true,
        local: true,
    },
    SpeechSpec {
        id: "custom",
        label: "Custom (OpenAI-compatible)",
        default_base_url: "",
        default_model: "whisper-1",
        needs_key: false,
        key_url: "",
        editable_base_url: true,
        local: false,
    },
];

pub fn catalog() -> &'static [SpeechSpec] {
    &CATALOG
}

pub fn spec(id: &str) -> Option<&'static SpeechSpec> {
    CATALOG.iter().find(|s| s.id == id)
}

/// The spec for a settings value; unknown ids fall back to OpenAI.
pub fn spec_or_default(id: &str) -> &'static SpeechSpec {
    spec(id).unwrap_or(&CATALOG[0])
}

/// The keychain account of a speech service's key (kept apart from the tutor's keys).
pub fn key_account(id: &str) -> String {
    format!("speech:{id}")
}

/// The model to use: `model` (trimmed) unless empty, else the service default.
pub fn effective_model(spec: &SpeechSpec, model: &str) -> String {
    match model.trim() {
        "" => spec.default_model.to_string(),
        m => m.to_string(),
    }
}

/// The address to use: `override_url` (trimmed, without a trailing `/`) when the service allows
/// it and it is not empty, else the catalog default. The same rule as the tutor's
/// (`catalog::effective_base_url`): `https://`, or `http://` on a local host; otherwise
/// [`BAD_ADDRESS`].
pub fn effective_base_url(spec: &SpeechSpec, override_url: &str) -> Result<String, String> {
    let o = override_url.trim().trim_end_matches('/');
    if spec.editable_base_url && !o.is_empty() {
        let ok = match url::Url::parse(o) {
            Ok(u) if u.scheme() == "https" && u.host().is_some() => true,
            Ok(u) if u.scheme() == "http" => is_local_host(o),
            _ => false,
        };
        if ok { Ok(o.to_string()) } else { Err(BAD_ADDRESS.to_string()) }
    } else {
        Ok(spec.default_base_url.to_string())
    }
}

/// The upload's file name, from the recording's type (`audio/webm;codecs=opus` → `audio.webm`).
/// Services pick the decoder from the extension.
pub fn file_name_for(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match base.as_str() {
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac" | "video/mp4" => "audio.mp4",
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "audio.wav",
        "audio/ogg" | "application/ogg" => "audio.ogg",
        "audio/mpeg" | "audio/mp3" => "audio.mp3",
        _ => "audio.webm",
    }
}

/// The type sent with the file part: the recording's type without parameters, or `audio/webm`.
fn part_mime(mime: &str) -> String {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if base.contains('/') { base } else { "audio/webm".to_string() }
}

/// A plausible ISO 639-1/639-3 code (`"it"`, `"en"`), else nothing (the service detects it).
fn language_code(language: Option<&str>) -> Option<String> {
    let l = language?.trim().to_ascii_lowercase();
    let l = l.split(['-', '_']).next().unwrap_or("").to_string();
    ((2..=3).contains(&l.len()) && l.chars().all(|c| c.is_ascii_lowercase())).then_some(l)
}

/// A short style hint per language, sent as the transcription `prompt` so that spoken maths is
/// written as symbols (`y = x + 10`) rather than words. Unknown or missing languages use English.
pub fn hint_for(language: Option<&str>) -> &'static str {
    match language.unwrap_or("") {
        "it" => "La matematica si scrive con i simboli: y = x + 10, x^2, radice(2), 1/2.",
        "fr" => "Les mathématiques s'écrivent avec des symboles : y = x + 10, x^2, racine(2), 1/2.",
        "es" => "Las matemáticas se escriben con símbolos: y = x + 10, x^2, raíz(2), 1/2.",
        "de" => "Mathematik wird mit Symbolen geschrieben: y = x + 10, x^2, Wurzel(2), 1/2.",
        "pt" => "A matemática escreve-se com símbolos: y = x + 10, x^2, raiz(2), 1/2.",
        "ja" => "数学は記号で書きます: y = x + 10, x^2, √2, 1/2。",
        "zh" => "数学用符号书写：y = x + 10，x^2，√2，1/2。",
        _ => "Mathematics is written in symbols: y = x + 10, x^2, sqrt(2), 1/2.",
    }
}

/// Whether the service accepts the OpenAI `prompt` field. Mistral's Voxtral transcription
/// endpoint documents no `prompt` parameter, so it is not sent there (unverified; revisit if
/// Mistral adds one).
fn accepts_prompt(spec: &SpeechSpec) -> bool {
    spec.id != "mistral"
}

/// Sends one recording to `{base}/audio/transcriptions` and returns the trimmed text.
///
/// `base_url` is the address setting (empty = the service default; ignored where the service does
/// not allow one), `model` the model setting (empty = the default), `key` may be empty for
/// services that need none. A refused address fails with [`AiError::BadAddress`] before anything
/// is sent; an empty transcript is [`AiError::InvalidResponse`].
pub fn transcribe(
    spec: &SpeechSpec,
    key: &str,
    model: &str,
    base_url: &str,
    bytes: Vec<u8>,
    mime: &str,
    language: Option<&str>,
) -> Result<String, AiError> {
    let base = effective_base_url(spec, base_url).map_err(|_| AiError::BadAddress)?;
    if base.is_empty() {
        return Err(AiError::BadAddress);
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(AiError::Rejected("the recording is larger than 25 MB".into()));
    }
    let model = effective_model(spec, model);
    let language = language_code(language);
    let prompt = accepts_prompt(spec).then(|| hint_for(language.as_deref()));
    let form = || -> Result<Form, AiError> {
        let file = Part::bytes(bytes.clone())
            .file_name(file_name_for(mime))
            .mime_str(&part_mime(mime))
            .map_err(|_| AiError::Rejected("unknown recording type".into()))?;
        let mut form = Form::new().part("file", file).text("model", model.clone()).text("response_format", "json");
        if let Some(lang) = &language {
            form = form.text("language", lang.clone());
        }
        if let Some(prompt) = prompt {
            form = form.text("prompt", prompt);
        }
        Ok(form)
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout_for(&base))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| AiError::Network("the request failed".into()))?;
    let key = key.trim();
    let send = || -> Result<(u16, String), AiError> {
        let mut req = client.post(format!("{base}/audio/transcriptions")).multipart(form()?);
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
        let res = req.send().map_err(|e| network_error(&e))?;
        let status = res.status().as_u16();
        let text = res.text().map_err(|e| network_error(&e))?;
        Ok((status, text))
    };
    let (status, text) = send()?;
    // One retry when the service is busy or failing for a moment (not when the quota is spent).
    let (status, text) = if is_transient(status, &text) {
        thread::sleep(RETRY_BACKOFF);
        send()?
    } else {
        (status, text)
    };
    reply(status, &text)
}

fn is_transient(status: u16, body: &str) -> bool {
    matches!(status, 500..=599) || (status == 429 && !is_quota_exhausted(body))
}

/// Maps a transcription reply (the status rules of the tutor's OpenAI client).
pub fn reply(status: u16, body: &str) -> Result<String, AiError> {
    match status {
        200..=299 => {
            let v: Value =
                serde_json::from_str(body).map_err(|_| AiError::InvalidResponse("the reply was not JSON".into()))?;
            let text = v["text"].as_str().map(str::trim).unwrap_or("");
            if text.is_empty() {
                Err(AiError::InvalidResponse(NO_TEXT.into()))
            } else {
                Ok(text.to_string())
            }
        }
        401 | 403 => Err(AiError::Auth),
        402 => Err(AiError::Billing),
        404 => Err(AiError::UnknownModel),
        400 | 413 | 415 | 422 => Err(AiError::Rejected(api_message(body, status))),
        408 => Err(AiError::Network("the request timed out".into())),
        429 if is_quota_exhausted(body) => Err(AiError::Billing),
        429 => Err(AiError::RateLimited),
        500..=599 => Err(AiError::Network(format!("the service answered {status}"))),
        _ => Err(AiError::InvalidResponse(format!("unexpected status {status}"))),
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

fn is_quota_exhausted(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .is_some_and(|v| ["code", "type"].iter().any(|k| v["error"][k].as_str() == Some("insufficient_quota")))
}

/// The API's own error message (never contains the key), shortened. Parentheses are dropped so
/// the UI can lift the detail out of the sentence.
fn api_message(body: &str, status: u16) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or_else(|| v["detail"].as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("status {status}"));
    msg.replace(['(', ')'], "").chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_and_defaults() {
        let ids: Vec<&str> = catalog().iter().map(|s| s.id).collect();
        assert_eq!(ids, ["openai", "groq", "mistral", "local", "custom"]);
        assert_eq!(spec_or_default("nope").id, "openai");
        assert_eq!(key_account("groq"), "speech:groq");
        for s in catalog() {
            assert_eq!(s.needs_key, !s.key_url.is_empty(), "{}", s.id);
            assert!(s.default_base_url.is_empty() || s.default_base_url.ends_with("/v1"), "{}", s.id);
        }
    }

    #[test]
    fn file_names_follow_the_type() {
        assert_eq!(file_name_for("audio/webm;codecs=opus"), "audio.webm");
        assert_eq!(file_name_for("audio/mp4"), "audio.mp4");
        assert_eq!(file_name_for("audio/wav"), "audio.wav");
        assert_eq!(file_name_for("audio/ogg; codecs=opus"), "audio.ogg");
        assert_eq!(file_name_for("audio/mpeg"), "audio.mp3");
        assert_eq!(file_name_for(""), "audio.webm");
        assert_eq!(part_mime("audio/webm;codecs=opus"), "audio/webm");
    }

    #[test]
    fn language_hint_is_a_short_code() {
        assert_eq!(language_code(Some("it")).as_deref(), Some("it"));
        assert_eq!(language_code(Some("en-GB")).as_deref(), Some("en"));
        assert_eq!(language_code(Some("system")), None);
        assert_eq!(language_code(Some("")), None);
        assert_eq!(language_code(None), None);
    }

    #[test]
    fn every_language_has_a_hint_and_unknown_ones_use_english() {
        for l in ["en", "it", "fr", "es", "de", "pt", "ja", "zh"] {
            assert!(!hint_for(Some(l)).is_empty(), "{l}");
        }
        assert_eq!(hint_for(None), hint_for(Some("en")));
        assert_eq!(hint_for(Some("xx")), hint_for(Some("en")));
        assert_ne!(hint_for(Some("it")), hint_for(Some("en")));
        assert!(accepts_prompt(spec("openai").unwrap()) && !accepts_prompt(spec("mistral").unwrap()));
    }

    #[test]
    fn local_servers_get_a_longer_timeout() {
        assert_eq!(timeout_for("https://api.openai.com/v1"), Duration::from_secs(120));
        assert_eq!(timeout_for("https://stt.example.com/v1"), Duration::from_secs(120));
        assert_eq!(timeout_for("http://127.0.0.1:8000/v1"), Duration::from_secs(300));
        assert_eq!(timeout_for("http://localhost:9000/v1"), Duration::from_secs(300));
        assert_eq!(timeout_for("http://192.168.1.5:9000/v1"), Duration::from_secs(300));
    }

    #[test]
    fn silence_is_a_valid_wav() {
        let w = silent_wav(500);
        assert_eq!(w.len(), 44 + 16_000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 16_000);
        assert_eq!(&w[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 16_000);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 16_000);
        assert!(w[44..].iter().all(|&b| b == 0));
    }

    #[test]
    fn only_busy_or_failing_replies_are_retried() {
        assert!(is_transient(503, ""));
        assert!(is_transient(429, "{}"));
        assert!(!is_transient(429, r#"{"error":{"code":"insufficient_quota"}}"#));
        assert!(!is_transient(401, ""));
        assert!(!is_transient(200, ""));
    }

    #[test]
    fn replies_map_to_errors() {
        assert_eq!(reply(200, r#"{"text":"  hello world \n"}"#).unwrap(), "hello world");
        assert!(matches!(reply(200, r#"{"text":"   "}"#), Err(AiError::InvalidResponse(_))));
        assert!(matches!(reply(200, "nope"), Err(AiError::InvalidResponse(_))));
        assert!(matches!(reply(401, ""), Err(AiError::Auth)));
        assert!(matches!(reply(404, ""), Err(AiError::UnknownModel)));
        assert!(matches!(reply(429, r#"{"error":{"code":"insufficient_quota"}}"#), Err(AiError::Billing)));
        assert!(matches!(reply(429, "{}"), Err(AiError::RateLimited)));
        assert!(matches!(reply(503, ""), Err(AiError::Network(_))));
        match reply(400, r#"{"error":{"message":"bad (audio) file"}}"#) {
            Err(AiError::Rejected(m)) => assert_eq!(m, "bad audio file"),
            other => panic!("{other:?}"),
        }
    }
}
