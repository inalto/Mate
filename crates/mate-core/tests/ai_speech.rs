//! Dictation transcription against a local stub HTTP server. Never touches the real network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use mate_core::ai::provider::AiError;
use mate_core::ai::speech::{
    MAX_AUDIO_BYTES, NO_TEXT, TimedText, effective_base_url, spec, timed_reply, transcribe, transcribe_timed,
};

#[derive(Debug, Clone, Default)]
struct Seen {
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Serves one scripted `(status, body)` reply, recording the request.
fn stub(status: u16, body: &'static str) -> (String, Arc<Mutex<Vec<Seen>>>) {
    stub_seq(vec![(status, body)])
}

/// Serves the scripted `(status, body)` replies in order, one per connection, recording each
/// request (before its reply is written, so it is there once the call returns).
fn stub_seq(replies: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
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
            log.lock().unwrap().push(Seen { path, headers, body: buf });
            let mut stream = stream;
            let reply = format!(
                "HTTP/1.1 {status} X
content-type: application/json
content-length: {}
connection: close

{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.flush();
        }
    });
    (base, seen)
}

#[test]
fn sends_a_multipart_form_and_reads_the_text() {
    let (base, seen) = stub(200, r#"{"text":" Ciao a tutti. "}"#);
    let local = spec("local").unwrap();
    let text = transcribe(
        local,
        "",
        "",
        &format!("{base}/v1/"),
        b"OPUSDATA".to_vec(),
        "audio/webm;codecs=opus",
        Some("it"),
        false,
    )
    .unwrap();
    assert_eq!(text, "Ciao a tutti.");
    let seen = seen.lock().unwrap()[0].clone();
    assert_eq!(seen.path, "/v1/audio/transcriptions");
    assert!(seen.header("authorization").is_none(), "no key, no header");
    assert!(seen.header("content-type").unwrap().starts_with("multipart/form-data; boundary="));
    let body = seen.body_text();
    assert!(body.contains(r#"name="file"; filename="audio.webm""#), "{body}");
    assert!(body.contains("Content-Type: audio/webm\r\n"), "{body}");
    assert!(body.contains("OPUSDATA"));
    assert!(body.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"), "{body}");
    assert!(body.contains("name=\"response_format\"\r\n\r\njson\r\n"), "{body}");
    assert!(body.contains("name=\"language\"\r\n\r\nit\r\n"), "{body}");
}

#[test]
fn sends_the_key_model_and_no_language_when_none() {
    let (base, seen) = stub(200, r#"{"text":"hello"}"#);
    let custom = spec("custom").unwrap();
    let text = transcribe(custom, " sk-test ", "my-model", &base, vec![1, 2, 3], "audio/mp4", None, false).unwrap();
    assert_eq!(text, "hello");
    let seen = seen.lock().unwrap()[0].clone();
    assert_eq!(seen.path, "/audio/transcriptions");
    assert_eq!(seen.header("authorization"), Some("Bearer sk-test"));
    let body = seen.body_text();
    assert!(body.contains(r#"filename="audio.mp4""#), "{body}");
    assert!(body.contains("name=\"model\"\r\n\r\nmy-model\r\n"), "{body}");
    assert!(!body.contains("name=\"language\""), "{body}");
}

fn prompt_sent(language: Option<&str>, math_hint: bool) -> bool {
    let (base, seen) = stub(200, r#"{"text":"x"}"#);
    transcribe(spec("custom").unwrap(), "", "", &base, vec![1], "audio/webm", language, math_hint).unwrap();
    let body = seen.lock().unwrap()[0].body_text();
    body.contains("name=\"prompt\"")
}

#[test]
fn the_style_hint_follows_the_language_and_the_setting() {
    // The stub is reached through the editable "custom" spec (Mistral is skipped by id; see the
    // unit test in speech.rs, since its address is fixed).
    let (base, seen) = stub(200, r#"{"text":"x"}"#);
    transcribe(spec("custom").unwrap(), "", "", &base, vec![1], "audio/webm", Some("it"), true).unwrap();
    let body = seen.lock().unwrap()[0].body_text();
    assert!(body.contains("name=\"prompt\"\r\n\r\nLa matematica"), "{body}");
    // Setting off, no language, or a language without a hint: no prompt field.
    assert!(!prompt_sent(Some("it"), false));
    assert!(!prompt_sent(None, true));
    assert!(!prompt_sent(Some("xx"), true));
}

#[test]
fn a_transcript_that_echoes_the_hint_is_no_text() {
    let hint = "La matematica si scrive con i simboli: y = x + 10, x^2, radice(2), 1/2.";
    for echoed in [hint, "La matematica si scrive con i simboli: y = x + 10, x^2, radice(2), 1/2", "La matematica si scrive con i simboli: y = x + 10, x^2, radice(2), 1/2. Grazie."] {
        let body: &'static str = Box::leak(serde_json::json!({ "text": echoed }).to_string().into_boxed_str());
        let (base, _) = stub(200, body);
        let r = transcribe(spec("custom").unwrap(), "", "", &base, vec![1], "audio/webm", Some("it"), true);
        assert!(matches!(&r, Err(AiError::InvalidResponse(m)) if m == "no text was recognised"), "{r:?}");
    }
    // Without the hint sent, the same words are a real transcript.
    let (base, _) = stub(200, r#"{"text":"La matematica si scrive con i simboli: y = x + 10, x^2, radice(2), 1/2."}"#);
    let r = transcribe(spec("custom").unwrap(), "", "", &base, vec![1], "audio/webm", Some("it"), false);
    assert!(r.is_ok(), "{r:?}");
}

#[test]
fn provider_errors_are_mapped() {
    let (base, _) = stub(401, r#"{"error":{"message":"bad key"}}"#);
    let r = transcribe(spec("custom").unwrap(), "k", "", &base, vec![0], "audio/webm", None, false);
    assert!(matches!(r, Err(AiError::Auth)), "{r:?}");
    let (base, _) = stub(200, r#"{"text":""}"#);
    let r = transcribe(spec("custom").unwrap(), "", "", &base, vec![0], "audio/webm", None, false);
    assert!(matches!(r, Err(AiError::InvalidResponse(_))), "{r:?}");
}

#[test]
fn refuses_bad_addresses_before_sending() {
    let custom = spec("custom").unwrap();
    for bad in ["http://example.com/v1", "ftp://127.0.0.1", "not a url"] {
        assert!(effective_base_url(custom, bad).is_err(), "{bad}");
        let r = transcribe(custom, "", "", bad, vec![0], "audio/webm", None, false);
        assert!(matches!(r, Err(AiError::BadAddress)), "{bad}: {r:?}");
    }
    // Custom without an address has nowhere to send.
    assert!(matches!(transcribe(custom, "", "", "", vec![0], "audio/webm", None, false), Err(AiError::BadAddress)));
    assert_eq!(effective_base_url(custom, "https://stt.example.com/v1/").unwrap(), "https://stt.example.com/v1");
    assert_eq!(effective_base_url(custom, "http://192.168.1.5:9000/v1").unwrap(), "http://192.168.1.5:9000/v1");
    // Cloud services ignore the address setting.
    let openai = spec("openai").unwrap();
    assert_eq!(effective_base_url(openai, "http://evil.example").unwrap(), "https://api.openai.com/v1");
}

#[test]
fn refuses_oversized_recordings() {
    let r = transcribe(spec("local").unwrap(), "", "", "", vec![0; MAX_AUDIO_BYTES + 1], "audio/webm", None, false);
    assert!(matches!(r, Err(AiError::Rejected(_))), "{r:?}");
}

#[test]
fn retries_once_when_the_service_fails_for_a_moment() {
    let (base, seen) = stub_seq(vec![(503, r#"{"error":{"message":"busy"}}"#), (200, r#"{"text":"again"}"#)]);
    let r = transcribe(spec("custom").unwrap(), "", "", &base, b"AUDIO".to_vec(), "audio/webm", None, false);
    assert_eq!(r.unwrap(), "again");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert!(seen[1].body_text().contains("AUDIO"), "the retry sends the recording again");
}

#[test]
fn a_second_failure_is_reported() {
    let (base, seen) = stub_seq(vec![(503, "{}"), (502, "{}"), (200, r#"{"text":"never"}"#)]);
    let r = transcribe(spec("custom").unwrap(), "", "", &base, vec![0], "audio/webm", None, false);
    assert!(matches!(r, Err(AiError::Network(_))), "{r:?}");
    assert_eq!(seen.lock().unwrap().len(), 2, "only one retry");
}

fn timed(start_ms: u64, end_ms: u64, text: &str) -> TimedText {
    TimedText { start_ms, end_ms, text: text.into() }
}

#[test]
fn timed_reply_reads_segments() {
    let body = r#"{"text":"a b","segments":[{"start":0.0,"end":1.5,"text":" a"},{"start":1.5,"end":3.25,"text":" b"},{"start":3.25,"end":4.0,"text":"  "}]}"#;
    assert_eq!(timed_reply(200, body, 10_000).unwrap(), [timed(0, 1500, "a"), timed(1500, 3250, "b")]);
}

#[test]
fn timed_reply_clamps_into_the_segment() {
    let body = r#"{"text":"a b","segments":[{"start":-0.2,"end":0.4,"text":"a"},{"start":2.9996,"end":3.6,"text":"b"}]}"#;
    assert_eq!(timed_reply(200, body, 3_000).unwrap(), [timed(0, 400, "a"), timed(3000, 3000, "b")]);
}

#[test]
fn timed_reply_without_segments_is_one_sentence() {
    assert_eq!(timed_reply(200, r#"{"text":" hello there "}"#, 4_000).unwrap(), [timed(0, 4000, "hello there")]);
    assert_eq!(timed_reply(200, r#"{"text":"hello","segments":[]}"#, 4_000).unwrap(), [timed(0, 4000, "hello")]);
}

#[test]
fn timed_reply_with_no_text_is_no_text_error() {
    for body in [r#"{"text":""}"#, r#"{"text":"  ","segments":[{"start":0,"end":1,"text":" "}]}"#] {
        let r = timed_reply(200, body, 1_000);
        assert!(matches!(&r, Err(AiError::InvalidResponse(m)) if m == NO_TEXT), "{r:?}");
    }
    assert!(matches!(timed_reply(401, "{}", 1_000), Err(AiError::Auth)));
}

#[test]
fn the_request_asks_for_verbose_json() {
    let (base, seen) = stub(200, r#"{"text":"a","segments":[{"start":0.5,"end":1.0,"text":"a"}]}"#);
    let r = transcribe_timed(spec("custom").unwrap(), "sk-t", "", &base, b"WEBM".to_vec(), "video/webm", Some("it"), false, 5_000);
    assert_eq!(r.unwrap(), [timed(500, 1000, "a")]);
    let seen = seen.lock().unwrap()[0].clone();
    assert_eq!(seen.path, "/audio/transcriptions");
    assert_eq!(seen.header("authorization"), Some("Bearer sk-t"));
    let body = seen.body_text();
    assert!(body.contains("name=\"response_format\"\r\n\r\nverbose_json\r\n"), "{body}");
    assert!(body.contains("name=\"timestamp_granularities[]\"\r\n\r\nsegment\r\n"), "{body}");
    assert!(body.contains("name=\"language\"\r\n\r\nit\r\n"), "{body}");
    // WebM audio sniffs as video: it is sent as audio.
    assert!(body.contains(r#"filename="audio.webm""#) && body.contains("Content-Type: audio/webm\r\n"), "{body}");
}

#[test]
fn an_mp4_recording_is_sent_as_m4a_audio() {
    let (base, seen) = stub(200, r#"{"text":"a"}"#);
    transcribe_timed(spec("custom").unwrap(), "", "", &base, vec![1], "video/mp4", None, false, 1_000).unwrap();
    let body = seen.lock().unwrap()[0].body_text();
    assert!(body.contains(r#"filename="audio.m4a""#) && body.contains("Content-Type: audio/mp4\r\n"), "{body}");
}

#[test]
fn refused_timestamps_fall_back_to_plain_json() {
    let (base, seen) = stub_seq(vec![
        (400, r#"{"error":{"message":"timestamp_granularities[] is not supported"}}"#),
        (200, r#"{"text":" whole part "}"#),
    ]);
    let r = transcribe_timed(spec("custom").unwrap(), "k", "", &base, b"AUDIO".to_vec(), "video/webm", None, false, 7_000);
    assert_eq!(r.unwrap(), [timed(0, 7000, "whole part")]);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    let second = seen[1].body_text();
    assert!(second.contains("name=\"response_format\"\r\n\r\njson\r\n"), "{second}");
    assert!(!second.contains("timestamp_granularities"), "{second}");
    assert!(second.contains("AUDIO"));
}

#[test]
fn other_rejections_are_not_retried_without_timestamps() {
    let (base, seen) = stub_seq(vec![(400, r#"{"error":{"message":"bad audio"}}"#), (200, r#"{"text":"x"}"#)]);
    let r = transcribe_timed(spec("custom").unwrap(), "", "", &base, vec![1], "video/webm", None, false, 1_000);
    assert!(matches!(r, Err(AiError::Rejected(_))), "{r:?}");
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn a_spent_quota_is_not_retried() {
    let (base, seen) = stub_seq(vec![(429, r#"{"error":{"code":"insufficient_quota"}}"#), (200, r#"{"text":"x"}"#)]);
    let r = transcribe(spec("custom").unwrap(), "", "", &base, vec![0], "audio/webm", None, false);
    assert!(matches!(r, Err(AiError::Billing)), "{r:?}");
    assert_eq!(seen.lock().unwrap().len(), 1);
}
