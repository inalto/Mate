//! The Nextcloud client against a local stub HTTP server. Never touches the real network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use mate_core::share::nextcloud::{Credentials, LoginFlow, NextcloudClient, PollError, normalize_server};
use serde_json::{Value, json};
use time::macros::date;

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn body_str(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Serves the scripted `(status, body)` replies in order, one per connection, recording requests.
fn stub(replies: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for (status, body) in replies {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("").to_string();
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
            log.lock().unwrap().push(Seen {
                method,
                path,
                headers,
                body: buf,
            });
            let mut stream = stream;
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.flush();
        }
    });
    (base, seen)
}

fn creds(server: &str) -> Credentials {
    Credentials {
        server: server.into(),
        user: "ann@example.com".into(),
        app_password: "s3cret-app".into(),
    }
}

fn ocs(status: u16, data: Value) -> String {
    json!({ "ocs": { "meta": { "status": if status < 300 { "ok" } else { "failure" }, "statuscode": status, "message": "" }, "data": data } })
        .to_string()
}

fn basic(user: &str, pw: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pw}"))
    )
}

#[test]
fn normalizes_server_addresses() {
    assert_eq!(
        normalize_server("cloud.example.com").unwrap(),
        "https://cloud.example.com"
    );
    assert_eq!(
        normalize_server(" https://cloud.example.com/ ").unwrap(),
        "https://cloud.example.com"
    );
    assert_eq!(
        normalize_server("https://example.com/nc/index.php/apps/files").unwrap(),
        "https://example.com/nc"
    );
    assert_eq!(
        normalize_server("http://localhost:8080").unwrap(),
        "http://localhost:8080"
    );
    assert_eq!(
        normalize_server("http://127.0.0.1:9").unwrap(),
        "http://127.0.0.1:9"
    );
    assert!(
        normalize_server("http://cloud.example.com")
            .unwrap_err()
            .contains("https://")
    );
    assert!(normalize_server("").is_err());
    assert!(normalize_server("ftp://x").is_err());
}

#[test]
fn credentials_round_trip_through_the_keychain_value_and_never_debug_print_the_password() {
    let c = creds("https://cloud.example.com");
    assert_eq!(
        c.encode(),
        "https://cloud.example.com\nann@example.com\ns3cret-app"
    );
    assert_eq!(Credentials::decode(&c.encode()), Some(c.clone()));
    assert_eq!(Credentials::decode("only-one-line"), None);
    assert_eq!(Credentials::decode("a\nb\n"), None);
    assert!(!format!("{c:?}").contains("s3cret"));
    let flow = LoginFlow {
        login_url: "https://x/login".into(),
        poll_endpoint: "https://x/poll".into(),
        token: "tok-123".into(),
    };
    assert!(!format!("{flow:?}").contains("tok-123"));
}

#[test]
fn login_flow_starts_then_polls_until_granted() {
    let start = json!({ "poll": { "token": "tok", "endpoint": "ENDPOINT" }, "login": "https://cloud.example.com/login/v2/flow/abc" });
    // A second stub serves the polls.
    let (poll_base, poll_seen) = stub(vec![
        (404, "[]".into()),
        (200, json!({ "server": "https://cloud.example.com/", "loginName": "ann", "appPassword": "app-pw" }).to_string()),
    ]);
    let start = start
        .to_string()
        .replace("ENDPOINT", &format!("{poll_base}/login/v2/poll"));
    let (base, seen) = stub(vec![(200, start)]);
    let client = NextcloudClient::new().unwrap();
    let flow = client.login_start(&base).unwrap();
    assert_eq!(
        flow.login_url,
        "https://cloud.example.com/login/v2/flow/abc"
    );
    assert_eq!(flow.token, "tok");
    {
        let s = seen.lock().unwrap();
        assert_eq!(s[0].method, "POST");
        assert_eq!(s[0].path, "/index.php/login/v2");
        assert!(s[0].header("user-agent").unwrap().starts_with("Mate"));
    }

    assert_eq!(client.login_poll(&flow).unwrap(), None);
    let c = client.login_poll(&flow).unwrap().unwrap();
    assert_eq!(
        c,
        Credentials {
            server: "https://cloud.example.com".into(),
            user: "ann".into(),
            app_password: "app-pw".into()
        }
    );
    let s = poll_seen.lock().unwrap();
    assert_eq!(s.len(), 2);
    assert_eq!(
        (s[0].method.as_str(), s[0].path.as_str()),
        ("POST", "/login/v2/poll")
    );
    assert_eq!(s[0].body_str(), "token=tok");
}

#[test]
fn login_start_reports_a_server_that_is_not_nextcloud() {
    let (base, _) = stub(vec![(404, "<html>nope</html>".into())]);
    let err = NextcloudClient::new()
        .unwrap()
        .login_start(&base)
        .unwrap_err();
    assert!(err.contains("Nextcloud"), "{err}");
}

#[test]
fn upload_creates_the_folder_then_puts_the_file() {
    let (base, seen) = stub(vec![
        (200, ocs(200, json!({ "id": "ann" }))),
        (201, String::new()),
        (201, String::new()),
    ]);
    let path = NextcloudClient::new()
        .unwrap()
        .upload(&creds(&base), "Maths 1.mate", b"PKzip".to_vec())
        .unwrap();
    assert_eq!(path, "/Mate/Maths 1.mate");
    let s = seen.lock().unwrap();
    assert_eq!(s.len(), 3);
    assert_eq!(s[0].method, "GET");
    assert!(
        s[0].path.starts_with("/ocs/v2.php/cloud/user"),
        "{}",
        s[0].path
    );
    assert_eq!(s[0].header("ocs-apirequest"), Some("true"));
    assert_eq!(
        (s[1].method.as_str(), s[1].path.as_str()),
        ("MKCOL", "/remote.php/dav/files/ann/Mate")
    );
    assert_eq!(
        (s[2].method.as_str(), s[2].path.as_str()),
        ("PUT", "/remote.php/dav/files/ann/Mate/Maths%201.mate")
    );
    assert_eq!(s[2].body, b"PKzip");
    for r in s.iter() {
        assert_eq!(
            r.header("authorization").map(str::to_owned),
            Some(basic("ann@example.com", "s3cret-app"))
        );
    }
}

#[test]
fn upload_accepts_an_existing_folder_and_an_overwrite() {
    let (base, seen) = stub(vec![
        (200, ocs(200, json!({ "id": "ann" }))),
        (405, String::new()),
        (204, String::new()),
    ]);
    NextcloudClient::new()
        .unwrap()
        .upload(&creds(&base), "Maths.mate", b"x".to_vec())
        .unwrap();
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[test]
fn upload_errors_are_plain_sentences() {
    let (base, _) = stub(vec![(401, ocs(401, Value::Null))]);
    let err = NextcloudClient::new()
        .unwrap()
        .upload(&creds(&base), "a.mate", vec![])
        .unwrap_err();
    assert!(err.contains("Sign in again"), "{err}");

    let (base, _) = stub(vec![
        (200, ocs(200, json!({ "id": "ann" }))),
        (201, String::new()),
        (507, String::new()),
    ]);
    let err = NextcloudClient::new()
        .unwrap()
        .upload(&creds(&base), "a.mate", vec![])
        .unwrap_err();
    assert!(err.contains("full"), "{err}");

    // Nothing listening.
    let addr = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let err = NextcloudClient::new()
        .unwrap()
        .upload(&creds(&format!("http://{addr}")), "a.mate", vec![])
        .unwrap_err();
    assert!(err.contains("Could not reach"), "{err}");
}

const NO_SHARES: fn() -> (u16, String) = || (200, ocs(200, json!([])));

#[test]
fn lists_existing_shares_then_creates_a_read_only_public_link_with_expiry() {
    let (base, seen) = stub(vec![
        NO_SHARES(),
        (
            200,
            ocs(
                200,
                json!({ "id": "7", "url": "https://cloud.example.com/s/AbC" }),
            ),
        ),
    ]);
    let url = NextcloudClient::new()
        .unwrap()
        .create_public_link(
            &creds(&base),
            "/Mate/Maths 1.mate",
            Some(date!(2026 - 11 - 01)),
        )
        .unwrap();
    assert_eq!(url, "https://cloud.example.com/s/AbC");
    let s = seen.lock().unwrap();
    assert_eq!(s.len(), 2);
    assert_eq!(s[0].method, "GET");
    assert!(
        s[0].path
            .starts_with("/ocs/v2.php/apps/files_sharing/api/v1/shares?"),
        "{}",
        s[0].path
    );
    assert!(s[0].path.contains("path=%2FMate%2FMaths+1.mate") || s[0].path.contains("path=%2FMate%2FMaths%201.mate"), "{}", s[0].path);
    assert!(s[0].path.contains("reshares=true"), "{}", s[0].path);
    assert_eq!(s[1].method, "POST");
    assert!(
        s[1].path
            .starts_with("/ocs/v2.php/apps/files_sharing/api/v1/shares"),
        "{}",
        s[1].path
    );
    assert_eq!(s[1].header("ocs-apirequest"), Some("true"));
    assert_eq!(s[1].header("accept"), Some("application/json"));
    let form: Vec<(String, String)> = url_pairs(&s[1].body_str());
    assert!(
        form.contains(&("path".into(), "/Mate/Maths 1.mate".into())),
        "{form:?}"
    );
    assert!(form.contains(&("shareType".into(), "3".into())));
    assert!(form.contains(&("permissions".into(), "1".into())));
    assert!(form.contains(&("expireDate".into(), "2026-11-01".into())));
}

#[test]
fn link_without_expiry_sends_no_expire_date() {
    let (base, seen) = stub(vec![
        NO_SHARES(),
        (200, ocs(200, json!({ "url": "https://c/s/x" }))),
    ]);
    NextcloudClient::new()
        .unwrap()
        .create_public_link(&creds(&base), "/Mate/a.mate", None)
        .unwrap();
    let s = seen.lock().unwrap();
    assert_eq!(s[1].method, "POST");
    assert!(!s[1].body_str().contains("expireDate"));
}

#[test]
fn an_existing_public_link_is_reused_with_the_new_expiry() {
    let (base, seen) = stub(vec![
        (
            200,
            ocs(
                200,
                json!([
                    { "id": "3", "share_type": 0, "url": null },
                    { "id": 9, "share_type": 3, "url": "https://c/s/Old" },
                    { "id": "10", "share_type": 3, "url": "https://c/s/Newer" }
                ]),
            ),
        ),
        (200, ocs(200, json!({ "id": "9", "url": "https://c/s/Old" }))),
    ]);
    let url = NextcloudClient::new()
        .unwrap()
        .create_public_link(&creds(&base), "/Mate/a.mate", Some(date!(2026 - 12 - 24)))
        .unwrap();
    assert_eq!(url, "https://c/s/Old");
    let s = seen.lock().unwrap();
    assert_eq!(s.len(), 2, "nothing is created");
    assert_eq!(s[1].method, "PUT");
    assert!(
        s[1].path
            .starts_with("/ocs/v2.php/apps/files_sharing/api/v1/shares/9"),
        "{}",
        s[1].path
    );
    assert_eq!(url_pairs(&s[1].body_str()), [("expireDate".to_string(), "2026-12-24".to_string())]);
}

#[test]
fn an_existing_public_link_without_expiry_has_its_expiry_cleared() {
    let (base, seen) = stub(vec![
        (
            200,
            ocs(
                200,
                json!([{ "id": "9", "share_type": 3, "url": "https://c/s/Old", "expiration": "2026-01-01 00:00:00" }]),
            ),
        ),
        (200, ocs(200, json!({ "id": "9", "url": "https://c/s/Old" }))),
    ]);
    let url = NextcloudClient::new()
        .unwrap()
        .create_public_link(&creds(&base), "/Mate/a.mate", None)
        .unwrap();
    assert_eq!(url, "https://c/s/Old");
    let s = seen.lock().unwrap();
    assert_eq!(s.len(), 2);
    assert_eq!(s[1].method, "PUT");
    assert_eq!(url_pairs(&s[1].body_str()), [("expireDate".to_string(), String::new())]);
}

#[test]
fn a_forbidden_link_says_public_links_are_off() {
    let (base, seen) = stub(vec![NO_SHARES(), (403, ocs(403, Value::Null))]);
    let err = NextcloudClient::new()
        .unwrap()
        .create_public_link(&creds(&base), "/Mate/a.mate", None)
        .unwrap_err();
    assert_eq!(err, "Public links are not allowed on this server.");
    assert_eq!(seen.lock().unwrap().len(), 2, "no fallback request");
}

#[test]
fn a_failed_share_listing_is_reported() {
    let (base, seen) = stub(vec![(401, ocs(401, Value::Null))]);
    let err = NextcloudClient::new()
        .unwrap()
        .create_public_link(&creds(&base), "/Mate/a.mate", None)
        .unwrap_err();
    assert!(err.contains("Sign in again"), "{err}");
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn a_refused_link_reports_the_server_message() {
    let body = json!({ "ocs": { "meta": { "status": "failure", "statuscode": 400, "message": "Passwords are enforced for link shares" }, "data": [] } });
    let (base, _) = stub(vec![NO_SHARES(), (400, body.to_string())]);
    let err = NextcloudClient::new()
        .unwrap()
        .create_public_link(&creds(&base), "/Mate/a.mate", None)
        .unwrap_err();
    assert!(err.contains("Passwords are enforced"), "{err}");
}

#[test]
fn login_poll_errors_say_whether_trying_again_may_help() {
    let addr = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let flow = |endpoint: String| LoginFlow {
        login_url: "https://x/login".into(),
        poll_endpoint: endpoint,
        token: "tok".into(),
    };
    let client = NextcloudClient::new().unwrap();
    let err = client
        .login_poll(&flow(format!("http://{addr}/login/v2/poll")))
        .unwrap_err();
    assert!(matches!(err, PollError::Network(_)), "{err:?}");
    assert!(err.to_string().contains("Could not reach"), "{err}");

    let (base, _) = stub(vec![(500, String::new()), (200, "{}".into())]);
    let err = client
        .login_poll(&flow(format!("{base}/login/v2/poll")))
        .unwrap_err();
    assert!(matches!(err, PollError::Failed(_)), "{err:?}");
    let err = client
        .login_poll(&flow(format!("{base}/login/v2/poll")))
        .unwrap_err();
    assert!(matches!(err, PollError::Failed(_)), "{err:?}");
}

#[test]
fn sign_out_revokes_the_app_password() {
    let (base, seen) = stub(vec![(200, ocs(200, json!([])))]);
    NextcloudClient::new()
        .unwrap()
        .revoke(&creds(&base))
        .unwrap();
    let s = seen.lock().unwrap();
    assert_eq!(s[0].method, "DELETE");
    assert!(
        s[0].path.starts_with("/ocs/v2.php/core/apppassword"),
        "{}",
        s[0].path
    );
    assert_eq!(
        s[0].header("authorization").map(str::to_owned),
        Some(basic("ann@example.com", "s3cret-app"))
    );
    assert_eq!(s[0].header("ocs-apirequest"), Some("true"));
}

/// Decodes an `application/x-www-form-urlencoded` body.
fn url_pairs(body: &str) -> Vec<(String, String)> {
    body.split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (decode(k), decode(v)))
        .collect()
}

fn decode(s: &str) -> String {
    let s = s.replace('+', " ");
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}
