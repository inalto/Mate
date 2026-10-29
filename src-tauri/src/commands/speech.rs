//! Dictation: speech-service keys, status and the transcription call. The key goes into the
//! keychain (account `speech:<id>`) and never comes back over IPC; a recording is sent only with
//! `settings.speechConsent == Some(true)`.

use std::sync::Arc;

use mate_core::ai::catalog::is_local_host;
use mate_core::ai::keystore::KeyStore;
use mate_core::ai::openai::extract_json_object;
use mate_core::ai::prompts::TIDY_DICTATION_SYSTEM;
use mate_core::ai::provider::{AiError, Provider, TextRequest};
use mate_core::ai::speech::{
    MAX_AUDIO_BYTES, NO_TEXT, SpeechSpec, catalog, effective_base_url, effective_model, key_account, silent_wav, spec,
    spec_or_default, transcribe, language_code,
};
use mate_core::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tauri::ipc::Request;

use super::ai::AiSetupError;
use super::ipc_body::body_bytes;
use super::recognize::{RecognizeError, connection, effective_model as tutor_model};
use crate::state::AppState;

/// One speech service as the UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub needs_key: bool,
    pub editable_base_url: bool,
    pub default_base_url: &'static str,
    pub default_model: &'static str,
    pub key_url: &'static str,
    pub local: bool,
}

/// What the UI may know about the dictation setup. Deliberately has no key field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    /// A key is stored (when one is needed) and the address is usable.
    pub configured: bool,
    pub has_key: bool,
    pub provider: String,
    pub model: String,
    /// The effective address; a refused setting is shown as typed, with `configured` false.
    pub base_url: String,
    pub consent: bool,
    pub needs_key: bool,
    /// The effective address is on this computer or the local network.
    pub local: bool,
}

fn setup_error(kind: &'static str, message: &str) -> AiSetupError {
    AiSetupError { kind, message: message.to_string(), detail: None }
}

/// The transcription call: `(spec, key, model, base_url, bytes, mime, language)`.
type SendFn<'a> = dyn FnOnce(&SpeechSpec, &str, &str, &str, Vec<u8>, &str, Option<&str>, bool) -> Result<String, AiError> + 'a;

/// Length of the settings' test recording (silence).
const TEST_CLIP_MS: u32 = 500;

pub fn providers() -> Vec<SpeechProviderInfo> {
    catalog()
        .iter()
        .map(|s| SpeechProviderInfo {
            id: s.id,
            label: s.label,
            needs_key: s.needs_key,
            editable_base_url: s.editable_base_url,
            default_base_url: s.default_base_url,
            default_model: s.default_model,
            key_url: s.key_url,
            local: s.local,
        })
        .collect()
}

fn check_provider(provider: &str) -> Result<(), String> {
    spec(provider).map(|_| ()).ok_or_else(|| format!("unknown speech service \"{provider}\""))
}

fn stored_key(store: &dyn KeyStore, provider: &str) -> Result<Option<String>, String> {
    Ok(store.get(&key_account(provider))?.filter(|k| !k.trim().is_empty()))
}

pub fn set_key(store: &dyn KeyStore, provider: &str, key: &str) -> Result<(), AiSetupError> {
    check_provider(provider)?;
    let key = key.trim();
    if key.is_empty() {
        return Err(setup_error("noKey", "Save an API key first."));
    }
    Ok(store.set(&key_account(provider), key)?)
}

pub fn clear_key(store: &dyn KeyStore, provider: &str) -> Result<(), String> {
    check_provider(provider)?;
    store.delete(&key_account(provider))
}

pub fn status(store: &dyn KeyStore, settings: &Settings) -> Result<SpeechStatus, String> {
    let s = spec_or_default(&settings.speech_provider);
    let checked = effective_base_url(s, &settings.speech_base_url);
    let valid = checked.is_ok();
    let base_url = checked.unwrap_or_else(|_| settings.speech_base_url.trim().trim_end_matches('/').to_string());
    let has_key = stored_key(store, s.id)?.is_some();
    let configured = valid && !base_url.is_empty() && (!s.needs_key || has_key);
    Ok(SpeechStatus {
        configured,
        has_key,
        provider: s.id.to_string(),
        model: effective_model(s, &settings.speech_model),
        local: valid && s.editable_base_url && is_local_host(&base_url),
        base_url,
        consent: settings.speech_consent == Some(true),
        needs_key: s.needs_key,
    })
}

/// The checks before anything is sent, then the call through `send` (the real one is
/// [`transcribe`]). Order: consent, size, key, address.
pub fn run(
    store: &dyn KeyStore,
    settings: &Settings,
    bytes: Vec<u8>,
    mime: &str,
    language: Option<&str>,
    send: impl FnOnce(&SpeechSpec, &str, &str, &str, Vec<u8>, &str, Option<&str>, bool) -> Result<String, AiError>,
) -> Result<String, AiSetupError> {
    if settings.speech_consent != Some(true) {
        return Err(setup_error("disabled", "Dictation is off. Turn it on in Settings, Dictation."));
    }
    if bytes.is_empty() {
        return Err(AiError::Rejected("the recording is empty".into()).into());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(AiError::Rejected("the recording is larger than 25 MB".into()).into());
    }
    let s = spec_or_default(&settings.speech_provider);
    let key = stored_key(store, s.id)?.unwrap_or_default();
    if s.needs_key && key.is_empty() {
        return Err(setup_error("noKey", "Save an API key first."));
    }
    let base_url = effective_base_url(s, &settings.speech_base_url).map_err(|_| AiError::BadAddress)?;
    if base_url.is_empty() {
        return Err(setup_error("noAddress", "Enter the service address first."));
    }
    Ok(send(s, &key, &settings.speech_model, &settings.speech_base_url, bytes, mime, language, settings.dictation_math)?)
}

/// The settings' test: half a second of silence through the same checks and call as a dictation.
/// Any transcript, or a reply that holds no text, means the service took the key and the audio.
pub fn test_key(store: &dyn KeyStore, settings: &Settings, send: Box<SendFn<'_>>) -> Result<(), AiSetupError> {
    run(store, settings, silent_wav(TEST_CLIP_MS), "audio/wav", None, |s, key, model, base, bytes, mime, lang, _| {
        match send(s, key, model, base, bytes, mime, lang, false) {
            Err(AiError::InvalidResponse(m)) if m == NO_TEXT => Ok(String::new()),
            other => other,
        }
    })
    .map(|_| ())
}

/// Runs a keychain operation off the async runtime (keychain calls can block on OS prompts).
async fn on_keychain<T: Send + 'static, E: From<String> + Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&dyn KeyStore) -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    let store: Arc<dyn KeyStore> = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || f(store.as_ref()))
        .await
        .map_err(|e| E::from(e.to_string()))?
}

/// The speech catalog, so the UI never keeps its own copy.
#[tauri::command]
pub fn list_speech_providers() -> Vec<SpeechProviderInfo> {
    providers()
}

#[tauri::command]
pub async fn get_speech_status(state: State<'_, AppState>) -> Result<SpeechStatus, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    on_keychain(&state, move |s| status(s, &settings)).await
}

#[tauri::command]
pub async fn set_speech_key(state: State<'_, AppState>, provider: String, key: String) -> Result<(), AiSetupError> {
    on_keychain(&state, move |s| set_key(s, &provider, &key)).await
}

#[tauri::command]
pub async fn clear_speech_key(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    on_keychain(&state, move |s| clear_key(s, &provider)).await
}

/// Transcribes the recording sent as the raw request body (`x-speech-mime`: its type,
/// `x-speech-language`: an optional language hint). Settings and key are read here, so only the
/// audio crosses IPC.
#[tauri::command]
pub async fn transcribe_audio(state: State<'_, AppState>, request: Request<'_>) -> Result<String, AiSetupError> {
    let bytes = body_bytes(request.body()).ok_or_else(|| "expected raw bytes".to_string())?.into_owned();
    let header = |name: &str| {
        request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
    };
    let mime = header("x-speech-mime").unwrap_or_else(|| "audio/webm".to_string());
    let language = header("x-speech-language");
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run(store.as_ref(), &settings, bytes, &mime, language.as_deref(), transcribe)
    })
    .await
    .map_err(|e| AiSetupError::from(e.to_string()))?
}

/// Sends a short silent recording to the configured service (needs consent, like dictation) and
/// reports whether it answered.
#[tauri::command]
pub async fn test_speech_key(state: State<'_, AppState>) -> Result<(), AiSetupError> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let store: Arc<dyn KeyStore> = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || test_key(store.as_ref(), &settings, Box::new(transcribe)))
        .await
        .map_err(|e| AiSetupError::from(e.to_string()))?
}

/// Longest dictated text sent to the assistant, in characters.
pub const MAX_TIDY_CHARS: usize = 1000;
/// Room for adaptive thinking plus the JSON reply.
const TIDY_MAX_TOKENS: u32 = 2048;

/// The tidied dictation: `kind` is `"text"` or `"math"`; `latex` is set only for `"math"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyResult {
    pub text: String,
    pub kind: String,
    pub latex: Option<String>,
}

fn tidy_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string" },
            "kind": { "type": "string", "enum": ["text", "math"] },
            "latex": { "anyOf": [{ "type": "string" }, { "type": "null" }] }
        },
        "required": ["text", "kind", "latex"],
        "additionalProperties": false
    })
}

/// The request for one dictated passage; the language is only a hint.
pub fn build_tidy_request(text: &str, language: Option<&str>) -> TextRequest {
    let lang = language_code(language).unwrap_or_else(|| "unknown".to_string());
    TextRequest {
        system: TIDY_DICTATION_SYSTEM.to_string(),
        user: format!("Language: {lang}\n\n<dictation>\n{text}\n</dictation>"),
        max_tokens: TIDY_MAX_TOKENS,
        json_schema: Some(tidy_schema()),
    }
}

/// Reads the model's reply leniently: code fences and text around the JSON object are ignored.
pub fn parse_tidy(reply: &str) -> Result<TidyResult, RecognizeError> {
    let bad = || AiError::InvalidResponse("the tidy-up reply was not understood".into());
    let json = extract_json_object(reply).ok_or_else(bad)?;
    let mut r: TidyResult = serde_json::from_str(json).map_err(|_| bad())?;
    r.text = r.text.trim().to_string();
    r.latex = r.latex.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    if r.text.is_empty() {
        return Err(bad().into());
    }
    // Maths without LaTeX, or an unknown kind, is plain text.
    if r.kind != "math" || r.latex.is_none() {
        r.kind = "text".into();
        r.latex = None;
    }
    Ok(r)
}

/// The trimmed text to tidy; `None` when there is nothing to send.
fn tidy_input(text: &str) -> Result<Option<String>, RecognizeError> {
    let t = text.trim();
    if t.chars().count() > MAX_TIDY_CHARS {
        return Err(RecognizeError {
            kind: "rejected",
            message: "That passage is too long to tidy. Dictate a shorter piece.".to_string(),
        });
    }
    Ok((!t.is_empty()).then(|| t.to_string()))
}

fn plain(text: String) -> TidyResult {
    TidyResult { text, kind: "text".into(), latex: None }
}

/// Tidies `text` with `provider`.
pub fn tidy_with(provider: &dyn Provider, text: &str, language: Option<&str>) -> Result<TidyResult, RecognizeError> {
    let Some(text) = tidy_input(text)? else { return Ok(plain(String::new())) };
    let reply = provider.complete(&build_tidy_request(&text, language))?;
    let r = parse_tidy(&reply)?;
    // A reply far longer than the input means the model added content.
    if r.text.chars().count() > 2 * text.chars().count() + 20 {
        return Err(AiError::InvalidResponse("the tidy-up reply was not understood".into()).into());
    }
    Ok(r)
}

/// The backend gate of the tidy-up: assistant consent and the dictation tidy-up setting.
fn tidy_gate(settings: &Settings) -> Result<(), RecognizeError> {
    if settings.ai_consent == Some(true) && settings.dictation_tidy {
        Ok(())
    } else {
        Err(AiError::Disabled.into())
    }
}

/// Longest wait for the whole tidy-up call (keychain, connection and reply).
const TIDY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Fixes punctuation and casing of a dictated passage and recognises spoken maths. Only the
/// transcribed text (never audio) goes to the AI assistant, and only with its consent; the
/// tutor switch is not required.
#[tauri::command]
pub async fn tidy_dictation(app: AppHandle, text: String, language: Option<String>) -> Result<TidyResult, RecognizeError> {
    let internal = |e: String| RecognizeError { kind: "internal", message: e };
    let settings = app.state::<AppState>().settings.lock().map_err(|e| internal(e.to_string()))?.clone();
    tidy_gate(&settings)?;
    let Some(text) = tidy_input(&text)? else { return Ok(plain(String::new())) };
    // Keychain access can block and the provider holds a blocking HTTP client: off the runtime.
    let work = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = connection(&settings, state.keys.as_ref())?;
        let model = tutor_model(&conn.provider, &conn.model);
        let provider = state.providers.get(&conn.provider, &model, &conn.key, &conn.base_url);
        tidy_with(provider.as_ref(), &text, language.as_deref())
    });
    match tokio::time::timeout(TIDY_TIMEOUT, work).await {
        Ok(joined) => joined.map_err(|e| internal(e.to_string()))?,
        Err(_) => Err(AiError::Network("the assistant took too long".into()).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;

    #[allow(clippy::too_many_arguments)]
    fn never(
        _: &SpeechSpec,
        _: &str,
        _: &str,
        _: &str,
        _: Vec<u8>,
        _: &str,
        _: Option<&str>,
        _: bool,
    ) -> Result<String, AiError> {
        panic!("nothing may be sent")
    }

    #[test]
    fn keys_live_under_their_own_account_and_never_leave_rust() {
        let store = MemoryStore::default();
        let settings = Settings::default();
        assert!(!status(&store, &settings).unwrap().configured);
        set_key(&store, "openai", "  sk-speech  ").unwrap();
        assert_eq!(store.get("speech:openai").unwrap().as_deref(), Some("sk-speech"));
        assert_eq!(store.get("openai").unwrap(), None, "the tutor's key is untouched");
        let st = status(&store, &settings).unwrap();
        assert!(st.configured && st.has_key && st.needs_key && !st.consent && !st.local);
        assert_eq!((st.model.as_str(), st.base_url.as_str()), ("gpt-4o-mini-transcribe", "https://api.openai.com/v1"));
        let json = serde_json::to_value(&st).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["baseUrl", "configured", "consent", "hasKey", "local", "model", "needsKey", "provider"]);
        assert!(!json.to_string().contains("sk-speech"));
        assert_eq!(set_key(&store, "openai", "  ").unwrap_err().kind, "noKey");
        assert!(set_key(&store, "nope", "k").is_err());
        clear_key(&store, "openai").unwrap();
        assert!(!status(&store, &settings).unwrap().has_key);
    }

    #[test]
    fn local_and_refused_addresses() {
        let store = MemoryStore::default();
        let mut settings = Settings { speech_provider: "local".into(), ..Settings::default() };
        let st = status(&store, &settings).unwrap();
        assert!(st.configured && st.local && !st.needs_key);
        settings.speech_provider = "custom".into();
        settings.speech_base_url = "http://example.com/v1".into();
        let st = status(&store, &settings).unwrap();
        assert!(!st.configured && !st.local);
        assert_eq!(st.base_url, "http://example.com/v1");
    }

    #[test]
    fn nothing_is_sent_without_consent_key_or_address() {
        let store = MemoryStore::default();
        let mut settings = Settings::default();
        let audio = || vec![1u8, 2, 3];
        assert_eq!(run(&store, &settings, audio(), "audio/webm", None, never).unwrap_err().kind, "disabled");
        settings.speech_consent = Some(false);
        assert_eq!(run(&store, &settings, audio(), "audio/webm", None, never).unwrap_err().kind, "disabled");
        settings.speech_consent = Some(true);
        assert_eq!(run(&store, &settings, audio(), "audio/webm", None, never).unwrap_err().kind, "noKey");
        assert_eq!(run(&store, &settings, Vec::new(), "audio/webm", None, never).unwrap_err().kind, "rejected");
        let big = vec![0u8; MAX_AUDIO_BYTES + 1];
        assert_eq!(run(&store, &settings, big, "audio/webm", None, never).unwrap_err().kind, "rejected");
        settings.speech_provider = "custom".into();
        assert_eq!(run(&store, &settings, audio(), "audio/webm", None, never).unwrap_err().kind, "noAddress");
        settings.speech_base_url = "http://example.com".into();
        assert_eq!(run(&store, &settings, audio(), "audio/webm", None, never).unwrap_err().kind, "badAddress");
    }

    #[test]
    fn sends_with_the_stored_key_and_settings() {
        let store = MemoryStore::default();
        store.set("speech:groq", "gk").unwrap();
        let settings = Settings { speech_provider: "groq".into(), speech_consent: Some(true), ..Settings::default() };
        let text = run(&store, &settings, vec![9], "audio/mp4", Some("it"), |s, key, model, base, bytes, mime, lang, math| {
            assert_eq!((s.id, key, model, base, mime, lang), ("groq", "gk", "", "", "audio/mp4", Some("it")));
            assert!(math, "dictation_math defaults on and is passed through");
            assert_eq!(bytes, [9]);
            Ok("ciao".into())
        })
        .unwrap();
        assert_eq!(text, "ciao");
        let err = run(&store, &settings, vec![9], "audio/mp4", None, |_, _, _, _, _, _, _, _| Err(AiError::Auth)).unwrap_err();
        assert_eq!(err.kind, "auth");
    }

    #[test]
    fn consent_error_is_worded_for_dictation() {
        let err = run(&MemoryStore::default(), &Settings::default(), vec![1], "audio/webm", None, never).unwrap_err();
        assert_eq!(err.kind, "disabled");
        assert!(err.message.contains("Dictation is off"), "{}", err.message);
    }

    #[test]
    fn the_test_sends_silence_and_accepts_an_empty_transcript() {
        let store = MemoryStore::default();
        let mut settings = Settings { speech_provider: "local".into(), ..Settings::default() };
        assert_eq!(test_key(&store, &settings, Box::new(never)).unwrap_err().kind, "disabled");
        settings.speech_consent = Some(true);
        let sent = std::cell::Cell::new(0usize);
        test_key(
            &store,
            &settings,
            Box::new(|s, _, _, _, bytes, mime, lang, math| {
                assert!(!math, "the test sends no style hint");
                assert_eq!((s.id, mime, lang), ("local", "audio/wav", None));
                assert_eq!(&bytes[0..4], b"RIFF");
                sent.set(bytes.len());
                Err(AiError::InvalidResponse(NO_TEXT.into()))
            }),
        )
        .unwrap();
        assert_eq!(sent.get(), 44 + 16_000);
        test_key(&store, &settings, Box::new(|_, _, _, _, _, _, _, _| Ok("you".into()))).unwrap();
        let err = test_key(&store, &settings, Box::new(|_, _, _, _, _, _, _, _| Err(AiError::Auth))).unwrap_err();
        assert_eq!(err.kind, "auth");
        let err = test_key(&store, &settings, Box::new(|_, _, _, _, _, _, _, _| Err(AiError::InvalidResponse("the reply was not JSON".into()))))
            .unwrap_err();
        assert_eq!(err.kind, "invalidResponse");
    }

    #[test]
    fn the_test_reaches_a_real_server() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read until the multipart body's closing boundary arrives.
            while !String::from_utf8_lossy(&buf).trim_end().ends_with("--") {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body = r#"{"text":""}"#;
            let reply = format!("HTTP/1.1 200 OK
content-type: application/json
content-length: {}
connection: close

{body}", body.len());
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&buf).into_owned()
        });
        let settings =
            Settings { speech_provider: "local".into(), speech_base_url: base, speech_consent: Some(true), ..Settings::default() };
        test_key(&MemoryStore::default(), &settings, Box::new(transcribe)).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/audio/transcriptions"), "{request}");
        assert!(request.contains(r#"filename="audio.wav""#), "{request}");
    }

    #[test]
    fn provider_list_mirrors_the_catalog() {
        let list = providers();
        assert_eq!(list.len(), catalog().len());
        let json = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(json["id"], "openai");
        assert_eq!(json["keyUrl"], "https://platform.openai.com/api-keys");
        assert_eq!(json["defaultModel"], "gpt-4o-mini-transcribe");
    }

    fn mock(replies: Vec<Result<String, AiError>>) -> mate_core::ai::mock::MockProvider {
        mate_core::ai::mock::MockProvider::new(Vec::new()).with_text(replies)
    }

    #[test]
    fn tidy_parses_json_and_fenced_json() {
        let p = mock(vec![
            Ok(r#"{"text":"y = x + 10","kind":"math","latex":"y = x + 10"}"#.into()),
            Ok("```json\n{\"text\":\"Hello, world.\",\"kind\":\"text\",\"latex\":null}\n```".into()),
            Ok(r#"{"text":"x","kind":"math","latex":null}"#.into()),
        ]);
        let r = tidy_with(&p, "  y equals x plus ten ", Some("en")).unwrap();
        assert_eq!(r, TidyResult { text: "y = x + 10".into(), kind: "math".into(), latex: Some("y = x + 10".into()) });
        let req = &p.text_requests()[0];
        assert_eq!(req.user, "Language: en\n\n<dictation>\ny equals x plus ten\n</dictation>");
        assert_eq!(req.system, TIDY_DICTATION_SYSTEM);
        assert!(req.json_schema.is_some());
        let r = tidy_with(&p, "hello world", None).unwrap();
        assert_eq!(r, plain("Hello, world.".into()));
        // Maths without LaTeX falls back to text.
        assert_eq!(tidy_with(&p, "x", None).unwrap().kind, "text");
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json, serde_json::json!({"text":"Hello, world.","kind":"text","latex":null}));
    }

    #[test]
    fn tidy_garbage_is_an_invalid_response() {
        let p = mock(vec![
            Ok("sorry, I cannot".into()),
            Ok("{not json}".into()),
            Ok(r#"{"text":" ","kind":"text","latex":null}"#.into()),
        ]);
        for _ in 0..3 {
            assert_eq!(tidy_with(&p, "hello", None).unwrap_err().kind, "invalidResponse");
        }
        let failing = mock(vec![Err(AiError::RateLimited)]);
        assert_eq!(tidy_with(&failing, "hello", None).unwrap_err().kind, "rateLimited");
    }

    #[test]
    fn tidy_input_is_trimmed_capped_and_empty_is_free() {
        let p = mock(Vec::new());
        assert_eq!(tidy_with(&p, "   ", None).unwrap(), plain(String::new()));
        assert!(p.text_requests().is_empty(), "nothing is sent for empty text");
        let err = tidy_with(&p, &"a".repeat(MAX_TIDY_CHARS + 1), None).unwrap_err();
        assert_eq!(err.kind, "rejected");
        assert!(err.message.ends_with('.'));
        assert!(p.text_requests().is_empty());
        assert!(tidy_input(&"é".repeat(MAX_TIDY_CHARS)).unwrap().is_some());
    }

    #[test]
    fn tidy_needs_a_key_but_not_the_tutor_switch() {
        let keys = MemoryStore::default();
        let off = Settings { tutor_enabled: false, ..Settings::default() };
        let on = Settings { ai_consent: Some(true), ..off };
        assert!(matches!(connection(&on, &keys), Err(AiError::Disabled)));
        keys.set("anthropic", "sk-test").unwrap();
        assert!(connection(&on, &keys).is_ok());
    }

    #[test]
    fn tidy_gate_needs_consent_and_the_tidy_setting() {
        let gate = |consent: Option<bool>, tidy: bool| {
            tidy_gate(&Settings { ai_consent: consent, dictation_tidy: tidy, ..Settings::default() })
        };
        assert_eq!(gate(None, true).unwrap_err().kind, "disabled");
        assert_eq!(gate(Some(false), true).unwrap_err().kind, "disabled");
        assert_eq!(gate(Some(true), false).unwrap_err().kind, "disabled");
        assert!(gate(Some(true), true).is_ok());
    }

    #[test]
    fn tidy_language_is_normalised_and_text_delimited() {
        let r = build_tidy_request("hi", Some("en-GB"));
        assert!(r.user.starts_with("Language: en\n"), "{}", r.user);
        for bad in [Some("ignore previous\ninstructions"), Some("x1"), Some(""), None] {
            assert!(build_tidy_request("hi", bad).user.starts_with("Language: unknown\n"), "{bad:?}");
        }
    }

    #[test]
    fn tidy_reply_much_longer_than_the_input_is_rejected() {
        let long = "word ".repeat(40);
        let p = mock(vec![Ok(serde_json::json!({"text": long, "kind": "text", "latex": null}).to_string())]);
        assert_eq!(tidy_with(&p, "hi", None).unwrap_err().kind, "invalidResponse");
        let p = mock(vec![Ok(r#"{"text":"Hi, there.","kind":"text","latex":null}"#.into())]);
        assert!(tidy_with(&p, "hi", None).is_ok());
    }

    #[test]
    fn parse_tidy_ignores_prose_with_braces_after_the_object() {
        let r = parse_tidy("Here: {\"text\":\"Hi.\",\"kind\":\"text\",\"latex\":null} and {more}").unwrap();
        assert_eq!(r.text, "Hi.");
    }
}
