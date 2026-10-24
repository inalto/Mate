//! Sharing a book: saving a `.mate` copy into a synced folder (Dropbox, Google Drive, OneDrive,
//! iCloud Drive, Nextcloud desktop) and uploading to Nextcloud for a public link. The Nextcloud
//! app password lives in the keychain (account [`NEXTCLOUD_ACCOUNT`]) and never reaches the
//! frontend, the settings or the log.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mate_core::ai::keystore::KeyStore;
use mate_core::archive::export_unit;
use mate_core::share::folders::{OsEnv, SyncFolder, detect};
use mate_core::share::nextcloud::{Credentials, LoginFlow, NextcloudClient};
use mate_core::share::{safe_file_name, unique_archive_path};
use mate_core::storage::Storage;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use super::export::write_atomically;
use crate::state::AppState;

/// Keychain account holding `server\nuser\nappPassword`.
pub const NEXTCLOUD_ACCOUNT: &str = "nextcloud";
/// Longest link expiry accepted, in days.
pub const MAX_EXPIRE_DAYS: u32 = 3650;

/// The Nextcloud sign-in in progress (its poll token stays here, in Rust).
#[derive(Default)]
pub struct ShareState {
    login: Mutex<Option<LoginFlow>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextcloudStatus {
    pub signed_in: bool,
    pub server: String,
    pub user: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub url: String,
    pub path: String,
}

fn blocking_err(e: impl std::fmt::Display) -> String {
    log::warn!("share: background task failed: {e}");
    "Something went wrong. Try again.".into()
}

/// The book's title and its `.mate` archive bytes.
fn export_book(
    storage: &Mutex<Storage>,
    assets_dir: &Path,
    unit_id: &str,
) -> Result<(String, Vec<u8>), String> {
    let storage = storage.lock().map_err(|e| e.to_string())?;
    let title = storage
        .list_tree()
        .map_err(|e| e.to_string())?
        .units
        .into_iter()
        .find(|u| u.id == unit_id && u.deleted_at.is_none())
        .map(|u| u.title)
        .ok_or_else(|| "That book no longer exists.".to_string())?;
    let bytes = export_unit(&storage, unit_id, assets_dir).map_err(|e| e.to_string())?;
    Ok((title, bytes))
}

/// Writes the book to `<dir>/Mate/<safe title>.mate` (numbered when taken) and returns that path.
pub fn save_archive(
    storage: &Mutex<Storage>,
    assets_dir: &Path,
    unit_id: &str,
    dir: &Path,
) -> Result<PathBuf, String> {
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("That folder is not available.".into());
    }
    let (title, bytes) = export_book(storage, assets_dir, unit_id)?;
    let folder = dir.join("Mate");
    fs::create_dir_all(&folder)
        .map_err(|_| "Could not create the Mate folder there.".to_string())?;
    let path = unique_archive_path(&folder, &safe_file_name(&title));
    write_atomically(&path, &bytes).map_err(|_| "Could not save the book there.".to_string())?;
    Ok(path)
}

/// The saved Nextcloud account, if any (an unreadable keychain counts as signed out).
fn saved_credentials(keys: &dyn KeyStore) -> Option<Credentials> {
    keys.get(NEXTCLOUD_ACCOUNT)
        .ok()
        .flatten()
        .and_then(|v| Credentials::decode(&v))
}

/// Server and user of the saved account; never the app password.
pub fn status_from(keys: &dyn KeyStore) -> NextcloudStatus {
    match saved_credentials(keys) {
        Some(c) => NextcloudStatus {
            signed_in: true,
            server: c.server,
            user: c.user,
        },
        None => NextcloudStatus {
            signed_in: false,
            server: String::new(),
            user: String::new(),
        },
    }
}

/// The last day a link stays valid, `days` from today.
pub fn expiry_date(days: Option<u32>, today: time::Date) -> Result<Option<time::Date>, String> {
    match days {
        None => Ok(None),
        Some(d) if (1..=MAX_EXPIRE_DAYS).contains(&d) => {
            Ok(today.checked_add(time::Duration::days(d.into())))
        }
        Some(_) => Err("Choose an expiry between 1 day and 10 years.".into()),
    }
}

/// The synced folders found on this machine.
#[tauri::command]
pub async fn detect_sync_folders() -> Result<Vec<SyncFolder>, String> {
    tauri::async_runtime::spawn_blocking(|| detect(&OsEnv))
        .await
        .map_err(blocking_err)
}

/// Saves the book into `<dir>/Mate/` and returns the written path.
#[tauri::command]
pub async fn save_archive_to(
    app: AppHandle,
    unit_id: String,
    dir: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, AppState> = tauri::Manager::state(&app);
        save_archive(
            &state.storage,
            &state.data_dir.join("assets"),
            &unit_id,
            Path::new(&dir),
        )
        .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(blocking_err)?
}

/// A directory chosen in a folder dialog; `None` if cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(blocking_err)?
}

#[tauri::command]
pub fn nextcloud_status(state: State<'_, AppState>) -> NextcloudStatus {
    status_from(state.keys.as_ref())
}

/// Starts Login Flow v2 on `server` and opens the sign-in page in the browser.
#[tauri::command]
pub async fn nextcloud_login_start(
    app: AppHandle,
    share: State<'_, ShareState>,
    server: String,
) -> Result<(), String> {
    let flow =
        tauri::async_runtime::spawn_blocking(move || NextcloudClient::new()?.login_start(&server))
            .await
            .map_err(blocking_err)??;
    if !(flow.login_url.starts_with("https://") || flow.login_url.starts_with("http://")) {
        return Err("This address does not look like a Nextcloud server.".into());
    }
    app.opener()
        .open_url(flow.login_url.clone(), None::<&str>)
        .map_err(|_| "Could not open the browser.".to_string())?;
    *share.login.lock().map_err(|e| e.to_string())? = Some(flow);
    Ok(())
}

/// Checks whether the user finished signing in; on success the app password goes to the keychain.
#[tauri::command]
pub async fn nextcloud_login_poll(
    state: State<'_, AppState>,
    share: State<'_, ShareState>,
) -> Result<LoginPoll, String> {
    let flow = share
        .login
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "Start signing in first.".to_string())?;
    let creds =
        tauri::async_runtime::spawn_blocking(move || NextcloudClient::new()?.login_poll(&flow))
            .await
            .map_err(blocking_err)??;
    let Some(creds) = creds else {
        return Ok(LoginPoll { done: false });
    };
    state.keys.set(NEXTCLOUD_ACCOUNT, &creds.encode())?;
    *share.login.lock().map_err(|e| e.to_string())? = None;
    Ok(LoginPoll { done: true })
}

/// Signs out: revokes the app password on the server (best effort) and removes it locally.
#[tauri::command]
pub async fn nextcloud_logout(
    state: State<'_, AppState>,
    share: State<'_, ShareState>,
) -> Result<(), String> {
    *share.login.lock().map_err(|e| e.to_string())? = None;
    if let Some(creds) = saved_credentials(state.keys.as_ref()) {
        let revoked =
            tauri::async_runtime::spawn_blocking(move || NextcloudClient::new()?.revoke(&creds))
                .await
                .map_err(blocking_err)?;
        if let Err(e) = revoked {
            log::warn!("nextcloud: the app password was not revoked on the server: {e}");
        }
    }
    state.keys.delete(NEXTCLOUD_ACCOUNT)
}

/// Uploads the book to `/Mate/` on Nextcloud and returns a read-only public link to it.
#[tauri::command]
pub async fn nextcloud_share(
    app: AppHandle,
    unit_id: String,
    expire_days: Option<u32>,
) -> Result<ShareLink, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, AppState> = tauri::Manager::state(&app);
        let creds = saved_credentials(state.keys.as_ref())
            .ok_or_else(|| "Sign in to Nextcloud in Settings first.".to_string())?;
        let expire = expiry_date(expire_days, time::OffsetDateTime::now_utc().date())?;
        let (title, bytes) = export_book(&state.storage, &state.data_dir.join("assets"), &unit_id)?;
        let client = NextcloudClient::new()?;
        let path = client.upload(&creds, &format!("{}.mate", safe_file_name(&title)), bytes)?;
        let url = client.create_public_link(&creds, &path, expire)?;
        Ok(ShareLink { url, path })
    })
    .await
    .map_err(blocking_err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::ai::keystore::MemoryStore;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mate-share-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn library(title: &str) -> Mutex<Storage> {
        let mut st = Storage::open_in_memory().unwrap();
        let now = mate_core::model::now_iso();
        st.upsert_unit(&mate_core::model::Unit {
            id: "u1".into(),
            title: title.into(),
            icon: None,
            color: None,
            is_favourite: false,
            bookshelf_id: None,
            is_expanded: true,
            order_index: 0,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
            version: 0,
        })
        .unwrap();
        Mutex::new(st)
    }

    #[test]
    fn saves_into_a_mate_subfolder_with_numbered_names() {
        let d = temp("save");
        let st = library("Maths: term 1");
        let first = save_archive(&st, &d.join("assets"), "u1", &d).unwrap();
        assert_eq!(first, d.join("Mate").join("Maths term 1.mate"));
        assert!(fs::read(&first).unwrap().starts_with(b"PK"));
        let second = save_archive(&st, &d.join("assets"), "u1", &d).unwrap();
        assert_eq!(second, d.join("Mate").join("Maths term 1 (2).mate"));
        // The archive imports back as a book.
        let mut other = Storage::open_in_memory().unwrap();
        mate_core::archive::import_archive(
            &mut other,
            &fs::read(&first).unwrap(),
            &d.join("assets2"),
        )
        .unwrap();
        assert_eq!(other.list_tree().unwrap().units[0].title, "Maths: term 1");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn save_refuses_missing_folders_and_books() {
        let d = temp("refuse");
        let st = library("Maths");
        assert_eq!(
            save_archive(&st, &d, "u1", &d.join("gone")).unwrap_err(),
            "That folder is not available."
        );
        assert_eq!(
            save_archive(&st, &d, "u1", Path::new("relative")).unwrap_err(),
            "That folder is not available."
        );
        assert_eq!(
            save_archive(&st, &d, "nope", &d).unwrap_err(),
            "That book no longer exists."
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn status_shows_server_and_user_but_never_the_password() {
        let keys = MemoryStore::default();
        assert_eq!(
            serde_json::to_value(status_from(&keys)).unwrap(),
            serde_json::json!({ "signedIn": false, "server": "", "user": "" })
        );
        keys.set(
            NEXTCLOUD_ACCOUNT,
            "https://cloud.example.com\nann\nvery-secret",
        )
        .unwrap();
        let json = serde_json::to_value(status_from(&keys)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "signedIn": true, "server": "https://cloud.example.com", "user": "ann" })
        );
        assert!(!json.to_string().contains("very-secret"));
        keys.set(NEXTCLOUD_ACCOUNT, "garbage").unwrap();
        assert!(!status_from(&keys).signed_in);
    }

    #[test]
    fn expiry_is_counted_from_today_and_bounded() {
        let today = time::macros::date!(2026 - 10 - 24);
        assert_eq!(expiry_date(None, today), Ok(None));
        assert_eq!(
            expiry_date(Some(7), today),
            Ok(Some(time::macros::date!(2026 - 10 - 31)))
        );
        assert!(expiry_date(Some(0), today).is_err());
        assert!(expiry_date(Some(MAX_EXPIRE_DAYS + 1), today).is_err());
    }

    #[test]
    fn dtos_serialise_in_camel_case() {
        assert_eq!(
            serde_json::to_value(LoginPoll { done: true }).unwrap(),
            serde_json::json!({ "done": true })
        );
        assert_eq!(
            serde_json::to_value(ShareLink {
                url: "u".into(),
                path: "/Mate/a.mate".into()
            })
            .unwrap(),
            serde_json::json!({ "url": "u", "path": "/Mate/a.mate" })
        );
    }
}
