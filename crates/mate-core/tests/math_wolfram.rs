//! Wolfram|Alpha short answers against a local stub HTTP server. Never touches the real network.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use mate_core::math::wolfram::{BAD_APPID, NO_SHORT_ANSWER, short_answer};

/// Serves one `(status, body)` reply and records the request line.
fn stub(status: u16, body: &str) -> (String, Arc<Mutex<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1/result", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(String::new()));
    let log = seen.clone();
    let body = body.to_string();
    thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else { return };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        *log.lock().unwrap() = line;
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).unwrap();
            if h.trim_end().is_empty() {
                break;
            }
        }
        let mut stream = stream;
        let reply = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(reply.as_bytes());
        let _ = stream.flush();
    });
    (base, seen)
}

#[test]
fn returns_the_text_and_sends_appid_query_and_metric_units() {
    let (url, seen) = stub(200, "4\n");
    assert_eq!(short_answer(&url, "SECRET-ID", "2+2").unwrap(), "4");
    let line = seen.lock().unwrap().clone();
    assert!(line.starts_with("GET /v1/result?"), "{line}");
    assert!(line.contains("appid=SECRET-ID"), "{line}");
    assert!(line.contains("i=2%2B2"), "{line}");
    assert!(line.contains("units=metric"), "{line}");
}

#[test]
fn status_501_means_no_short_answer() {
    let (url, _) = stub(501, "Wolfram|Alpha did not understand your input");
    assert_eq!(short_answer(&url, "id", "asdf").unwrap_err(), NO_SHORT_ANSWER);
}

#[test]
fn status_403_means_bad_appid() {
    let (url, _) = stub(403, "Invalid appid");
    assert_eq!(short_answer(&url, "id", "2+2").unwrap_err(), BAD_APPID);
}

#[test]
fn other_failures_are_short_plain_text_without_the_appid() {
    let (url, _) = stub(500, "boom");
    let e = short_answer(&url, "SECRET-ID", "2+2").unwrap_err();
    assert!(e.contains("500") && !e.contains("SECRET-ID"), "{e}");
    // Nothing listening: the transport error must not carry the URL (and the AppID in it).
    let e = short_answer("http://127.0.0.1:1/v1/result", "SECRET-ID", "2+2").unwrap_err();
    assert!(!e.contains("SECRET-ID") && !e.contains("127.0.0.1"), "{e}");
}

#[test]
fn empty_query_is_refused_without_a_request() {
    assert!(short_answer("http://127.0.0.1:1/", "id", "  ").is_err());
}
