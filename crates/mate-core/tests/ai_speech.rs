//! Dictation transcription against a local stub HTTP server. Never touches the real network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use mate_core::ai::provider::AiError;
use mate_core::ai::speech::{MAX_AUDIO_BYTES, effective_base_url, spec, transcribe};

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
fn stub(status: u16, body: &'static str) -> (String, Arc<Mutex<Option<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(None));
    let log = seen.clone();
    thread::spawn(move || {
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
        *log.lock().unwrap() = Some(Seen { path, headers, body: buf });
        let mut stream = stream;
        let reply = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(reply.as_bytes());
        let _ = stream.flush();
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
    )
    .unwrap();
    assert_eq!(text, "Ciao a tutti.");
    let seen = seen.lock().unwrap().clone().unwrap();
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
    let text = transcribe(custom, " sk-test ", "my-model", &base, vec![1, 2, 3], "audio/mp4", None).unwrap();
    assert_eq!(text, "hello");
    let seen = seen.lock().unwrap().clone().unwrap();
    assert_eq!(seen.path, "/audio/transcriptions");
    assert_eq!(seen.header("authorization"), Some("Bearer sk-test"));
    let body = seen.body_text();
    assert!(body.contains(r#"filename="audio.mp4""#), "{body}");
    assert!(body.contains("name=\"model\"\r\n\r\nmy-model\r\n"), "{body}");
    assert!(!body.contains("name=\"language\""), "{body}");
}

#[test]
fn provider_errors_are_mapped() {
    let (base, _) = stub(401, r#"{"error":{"message":"bad key"}}"#);
    let r = transcribe(spec("custom").unwrap(), "k", "", &base, vec![0], "audio/webm", None);
    assert!(matches!(r, Err(AiError::Auth)), "{r:?}");
    let (base, _) = stub(200, r#"{"text":""}"#);
    let r = transcribe(spec("custom").unwrap(), "", "", &base, vec![0], "audio/webm", None);
    assert!(matches!(r, Err(AiError::InvalidResponse(_))), "{r:?}");
}

#[test]
fn refuses_bad_addresses_before_sending() {
    let custom = spec("custom").unwrap();
    for bad in ["http://example.com/v1", "ftp://127.0.0.1", "not a url"] {
        assert!(effective_base_url(custom, bad).is_err(), "{bad}");
        let r = transcribe(custom, "", "", bad, vec![0], "audio/webm", None);
        assert!(matches!(r, Err(AiError::BadAddress)), "{bad}: {r:?}");
    }
    // Custom without an address has nowhere to send.
    assert!(matches!(transcribe(custom, "", "", "", vec![0], "audio/webm", None), Err(AiError::BadAddress)));
    assert_eq!(effective_base_url(custom, "https://stt.example.com/v1/").unwrap(), "https://stt.example.com/v1");
    assert_eq!(effective_base_url(custom, "http://192.168.1.5:9000/v1").unwrap(), "http://192.168.1.5:9000/v1");
    // Cloud services ignore the address setting.
    let openai = spec("openai").unwrap();
    assert_eq!(effective_base_url(openai, "http://evil.example").unwrap(), "https://api.openai.com/v1");
}

#[test]
fn refuses_oversized_recordings() {
    let r = transcribe(spec("local").unwrap(), "", "", "", vec![0; MAX_AUDIO_BYTES + 1], "audio/webm", None);
    assert!(matches!(r, Err(AiError::Rejected(_))), "{r:?}");
}
