//! Dictation: speech-service keys, status and the transcription call. The key goes into the
//! keychain (account `speech:<id>`) and never comes back over IPC; a recording is sent only with
//! `settings.speechConsent == Some(true)`.

use std::sync::Arc;

use mate_core::ai::catalog::is_local_host;
use mate_core::ai::keystore::KeyStore;
use mate_core::ai::provider::AiError;
use mate_core::ai::speech::{
    MAX_AUDIO_BYTES, NO_TEXT, SpeechSpec, catalog, effective_base_url, effective_model, key_account, silent_wav, spec,
    spec_or_default, transcribe,
};
use mate_core::settings::Settings;
use serde::Serialize;
use tauri::State;
use tauri::ipc::Request;

use super::ai::AiSetupError;
use super::ipc_body::body_bytes;
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
type SendFn<'a> = dyn FnOnce(&SpeechSpec, &str, &str, &str, Vec<u8>, &str, Option<&str>) -> Result<String, AiError> + 'a;

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
    send: impl FnOnce(&SpeechSpec, &str, &str, &str, Vec<u8>, &str, Option<&str>) -> Result<String, AiError>,
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
    Ok(send(s, &key, &settings.speech_model, &settings.speech_base_url, bytes, mime, language)?)
}

/// The settings' test: half a second of silence through the same checks and call as a dictation.
/// Any transcript, or a reply that holds no text, means the service took the key and the audio.
pub fn test_key(store: &dyn KeyStore, settings: &Settings, send: Box<SendFn<'_>>) -> Result<(), AiSetupError> {
    run(store, settings, silent_wav(TEST_CLIP_MS), "audio/wav", None, |s, key, model, base, bytes, mime, lang| {
        match send(s, key, model, base, bytes, mime, lang) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;

    fn never(
        _: &SpeechSpec,
        _: &str,
        _: &str,
        _: &str,
        _: Vec<u8>,
        _: &str,
        _: Option<&str>,
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
        let text = run(&store, &settings, vec![9], "audio/mp4", Some("it"), |s, key, model, base, bytes, mime, lang| {
            assert_eq!((s.id, key, model, base, mime, lang), ("groq", "gk", "", "", "audio/mp4", Some("it")));
            assert_eq!(bytes, [9]);
            Ok("ciao".into())
        })
        .unwrap();
        assert_eq!(text, "ciao");
        let err = run(&store, &settings, vec![9], "audio/mp4", None, |_, _, _, _, _, _, _| Err(AiError::Auth)).unwrap_err();
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
            Box::new(|s, _, _, _, bytes, mime, lang| {
                assert_eq!((s.id, mime, lang), ("local", "audio/wav", None));
                assert_eq!(&bytes[0..4], b"RIFF");
                sent.set(bytes.len());
                Err(AiError::InvalidResponse(NO_TEXT.into()))
            }),
        )
        .unwrap();
        assert_eq!(sent.get(), 44 + 16_000);
        test_key(&store, &settings, Box::new(|_, _, _, _, _, _, _| Ok("you".into()))).unwrap();
        let err = test_key(&store, &settings, Box::new(|_, _, _, _, _, _, _| Err(AiError::Auth))).unwrap_err();
        assert_eq!(err.kind, "auth");
        let err = test_key(&store, &settings, Box::new(|_, _, _, _, _, _, _| Err(AiError::InvalidResponse("the reply was not JSON".into()))))
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
}
