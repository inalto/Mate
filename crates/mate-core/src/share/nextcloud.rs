//! Nextcloud: sign-in with Login Flow v2, upload to `/Mate/` over WebDAV and a read-only public
//! link through the OCS sharing API. Blocking HTTP (call off the async runtime); every error is a
//! short sentence for the user. The app password is never logged or printed (`Debug` hides it).

use std::fmt;
use std::time::Duration;

use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::{Method, StatusCode, Url};
use serde_json::Value;

/// Folder (in the user's files) that shared books go to.
pub const FOLDER: &str = "Mate";
/// Per-request timeout; uploads get extra time for their size.
const TIMEOUT: Duration = Duration::from_secs(30);
const BAD_ADDRESS: &str = "The saved Nextcloud address is not valid. Sign in again.";

/// A started Login Flow v2: the page the user signs in on, and where to poll for the result.
#[derive(Clone, PartialEq, Eq)]
pub struct LoginFlow {
    pub login_url: String,
    pub poll_endpoint: String,
    pub token: String,
}

impl fmt::Debug for LoginFlow {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginFlow")
            .field("login_url", &self.login_url)
            .field("poll_endpoint", &self.poll_endpoint)
            .field("token", &"<hidden>")
            .finish()
    }
}

/// A signed-in account: server address (no trailing slash), login name and app password.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub server: String,
    pub user: String,
    pub app_password: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("server", &self.server)
            .field("user", &self.user)
            .field("app_password", &"<hidden>")
            .finish()
    }
}

impl Credentials {
    /// The keychain value: `server\nuser\nappPassword`.
    pub fn encode(&self) -> String {
        format!("{}\n{}\n{}", self.server, self.user, self.app_password)
    }

    /// Reads [`Credentials::encode`]'s format; `None` when a part is missing or empty.
    pub fn decode(value: &str) -> Option<Credentials> {
        let mut parts = value.splitn(3, '\n');
        let (server, user, app_password) = (parts.next()?, parts.next()?, parts.next()?);
        if server.is_empty() || user.is_empty() || app_password.is_empty() {
            return None;
        }
        Some(Credentials {
            server: server.into(),
            user: user.into(),
            app_password: app_password.into(),
        })
    }
}

fn is_local_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// The server address the user typed, as `https://host[/path]` without a trailing slash:
/// `https://` is added when no scheme is given, and anything from `/index.php` on is dropped.
/// Plain `http://` is accepted only for this computer (`localhost`).
pub fn normalize_server(input: &str) -> Result<String, String> {
    const INVALID: &str = "Enter your Nextcloud address, like cloud.example.com.";
    let raw = input.trim();
    if raw.is_empty() {
        return Err(INVALID.into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| INVALID.to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if is_local_host(&url) => {}
        "http" => return Err("Use an https:// address for your Nextcloud server.".into()),
        _ => return Err(INVALID.into()),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(INVALID.into());
    }
    let path = url
        .path()
        .split("/index.php")
        .next()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_owned();
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn transport_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The Nextcloud server took too long to answer. Try again.".into()
    } else {
        "Could not reach the Nextcloud server. Check the address and your connection.".into()
    }
}

/// The sentence for an unexpected HTTP status.
fn status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "Nextcloud did not accept the sign-in. Sign in again in Settings.".into(),
        403 => "Nextcloud did not allow this.".into(),
        404 => "Nextcloud could not find the folder for this account.".into(),
        507 => "Your Nextcloud storage is full.".into(),
        code => format!("Nextcloud answered with an error ({code})."),
    }
}

/// An OCS reply: HTTP status, `ocs.meta.statuscode`, `ocs.meta.message` and `ocs.data`.
struct Ocs {
    status: StatusCode,
    code: Option<u64>,
    message: String,
    data: Value,
}

impl Ocs {
    /// HTTP 2xx and a 100 (v1) or 200 (v2) OCS status code.
    fn ok(&self) -> bool {
        self.status.is_success() && matches!(self.code, Some(100 | 200) | None)
    }

    /// The sentence for a failed reply: the server's own message when it gave one.
    fn error(&self) -> String {
        if self.status == StatusCode::UNAUTHORIZED || self.code == Some(997) {
            status_error(StatusCode::UNAUTHORIZED)
        } else if self.message.is_empty() {
            status_error(if self.status.is_success() {
                StatusCode::BAD_REQUEST
            } else {
                self.status
            })
        } else {
            format!("Nextcloud said: {}", self.message)
        }
    }
}

/// A Nextcloud HTTP client (30 s per request).
pub struct NextcloudClient {
    http: Client,
}

impl NextcloudClient {
    pub fn new() -> Result<NextcloudClient, String> {
        let http = Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("Mate/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "Could not start a connection to Nextcloud.".to_string())?;
        Ok(NextcloudClient { http })
    }

    fn send(&self, req: RequestBuilder) -> Result<Response, String> {
        req.send().map_err(transport_error)
    }

    fn ocs(
        &self,
        creds: &Credentials,
        method: Method,
        path: &str,
    ) -> Result<RequestBuilder, String> {
        let url = Url::parse(&format!("{}/ocs/v2.php/{path}", creds.server))
            .map_err(|_| BAD_ADDRESS.to_string())?;
        Ok(self
            .http
            .request(method, url)
            .basic_auth(&creds.user, Some(&creds.app_password))
            .header("OCS-APIRequest", "true")
            .header("Accept", "application/json")
            .query(&[("format", "json")]))
    }

    fn ocs_reply(&self, req: RequestBuilder) -> Result<Ocs, String> {
        let resp = self.send(req)?;
        let status = resp.status();
        let body: Value = resp.json().unwrap_or(Value::Null);
        let meta = &body["ocs"]["meta"];
        Ok(Ocs {
            status,
            code: meta["statuscode"].as_u64(),
            message: meta["message"].as_str().unwrap_or("").trim().to_owned(),
            data: body["ocs"]["data"].clone(),
        })
    }

    /// Starts Login Flow v2 on `server` (see [`normalize_server`]).
    pub fn login_start(&self, server: &str) -> Result<LoginFlow, String> {
        const NOT_NEXTCLOUD: &str = "This address does not look like a Nextcloud server.";
        let server = normalize_server(server)?;
        let resp = self.send(self.http.post(format!("{server}/index.php/login/v2")))?;
        if !resp.status().is_success() {
            return Err(NOT_NEXTCLOUD.into());
        }
        let body: Value = resp.json().map_err(|_| NOT_NEXTCLOUD.to_string())?;
        let field = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        match (
            field(&body["login"]),
            field(&body["poll"]["endpoint"]),
            field(&body["poll"]["token"]),
        ) {
            (Some(login_url), Some(poll_endpoint), Some(token)) => Ok(LoginFlow {
                login_url,
                poll_endpoint,
                token,
            }),
            _ => Err(NOT_NEXTCLOUD.into()),
        }
    }

    /// Asks whether the user has granted access yet: `None` while waiting.
    pub fn login_poll(&self, flow: &LoginFlow) -> Result<Option<Credentials>, String> {
        const UNEXPECTED: &str = "Nextcloud sent an unexpected sign-in reply.";
        let req = self
            .http
            .post(&flow.poll_endpoint)
            .form(&[("token", flow.token.as_str())]);
        let resp = self.send(req)?;
        match resp.status() {
            StatusCode::NOT_FOUND => return Ok(None),
            s if !s.is_success() => return Err(status_error(s)),
            _ => {}
        }
        let body: Value = resp.json().map_err(|_| UNEXPECTED.to_string())?;
        let field = |k: &str| {
            body[k]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let (Some(server), Some(user), Some(app_password)) =
            (field("server"), field("loginName"), field("appPassword"))
        else {
            return Err(UNEXPECTED.into());
        };
        Ok(Some(Credentials {
            server: normalize_server(&server)?,
            user,
            app_password,
        }))
    }

    /// The account's user id (its WebDAV folder name), which can differ from the login name.
    fn user_id(&self, creds: &Credentials) -> Result<String, String> {
        let reply = self.ocs_reply(self.ocs(creds, Method::GET, "cloud/user")?)?;
        if !reply.ok() {
            return Err(reply.error());
        }
        Ok(reply.data["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&creds.user)
            .to_owned())
    }

    fn dav_url(&self, creds: &Credentials, user_id: &str, parts: &[&str]) -> Result<Url, String> {
        let mut url = Url::parse(&creds.server).map_err(|_| BAD_ADDRESS.to_string())?;
        url.path_segments_mut()
            .map_err(|_| BAD_ADDRESS.to_string())?
            .pop_if_empty()
            .extend(["remote.php", "dav", "files", user_id])
            .extend(parts);
        Ok(url)
    }

    /// Uploads `bytes` as `/Mate/<file_name>` (creating the folder; an existing file is
    /// replaced) and returns that path.
    pub fn upload(
        &self,
        creds: &Credentials,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        let user_id = self.user_id(creds)?;
        let mkcol = Method::from_bytes(b"MKCOL").expect("valid method");
        let folder = self.dav_url(creds, &user_id, &[FOLDER])?;
        let resp = self.send(
            self.http
                .request(mkcol, folder)
                .basic_auth(&creds.user, Some(&creds.app_password)),
        )?;
        // 405: the folder already exists.
        if !resp.status().is_success() && resp.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(status_error(resp.status()));
        }
        let file = self.dav_url(creds, &user_id, &[FOLDER, file_name])?;
        let extra = Duration::from_secs(bytes.len() as u64 / (256 * 1024));
        let resp = self.send(
            self.http
                .put(file)
                .basic_auth(&creds.user, Some(&creds.app_password))
                .header("Content-Type", "application/octet-stream")
                .timeout(TIMEOUT + extra)
                .body(bytes),
        )?;
        if !resp.status().is_success() {
            return Err(status_error(resp.status()));
        }
        Ok(format!("/{FOLDER}/{file_name}"))
    }

    /// A read-only public link to `path` (as returned by [`upload`](Self::upload)), valid until
    /// `expire` when given. A file that already has a public link keeps it (with the new expiry).
    pub fn create_public_link(
        &self,
        creds: &Credentials,
        path: &str,
        expire: Option<time::Date>,
    ) -> Result<String, String> {
        const SHARES: &str = "apps/files_sharing/api/v1/shares";
        const NO_LINK: &str = "Nextcloud did not return a link.";
        let expire =
            expire.map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day()));
        let mut form = vec![
            ("path", path.to_owned()),
            ("shareType", "3".to_owned()),
            ("permissions", "1".to_owned()),
        ];
        if let Some(date) = &expire {
            form.push(("expireDate", date.clone()));
        }
        let created = self.ocs_reply(self.ocs(creds, Method::POST, SHARES)?.form(&form))?;
        if created.ok() {
            return created.data["url"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| NO_LINK.to_string());
        }
        if created.status != StatusCode::FORBIDDEN && created.code != Some(403) {
            return Err(created.error());
        }
        // Already shared: reuse the file's existing public link.
        let listed = self.ocs_reply(
            self.ocs(creds, Method::GET, SHARES)?
                .query(&[("path", path), ("reshares", "false")]),
        )?;
        let existing = listed
            .ok()
            .then(|| listed.data.as_array())
            .flatten()
            .and_then(|shares| {
                shares
                    .iter()
                    .find(|s| s["share_type"].as_u64() == Some(3) && s["url"].is_string())
            });
        let Some(share) = existing else {
            return Err(created.error());
        };
        let url = share["url"].as_str().unwrap_or_default().to_owned();
        if let Some(date) = expire {
            let id = match &share["id"] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => return Err(NO_LINK.into()),
            };
            let updated = self.ocs_reply(
                self.ocs(creds, Method::PUT, &format!("{SHARES}/{id}"))?
                    .form(&[("expireDate", date)]),
            )?;
            if !updated.ok() {
                return Err(updated.error());
            }
        }
        Ok(url)
    }

    /// Revokes the app password on the server (sign out).
    pub fn revoke(&self, creds: &Credentials) -> Result<(), String> {
        let reply = self.ocs_reply(self.ocs(creds, Method::DELETE, "core/apppassword")?)?;
        if reply.ok() {
            Ok(())
        } else {
            Err(reply.error())
        }
    }
}
