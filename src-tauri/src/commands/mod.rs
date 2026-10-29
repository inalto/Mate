pub mod ai;
pub mod archive;
pub mod ask;
pub mod assets;
pub mod elements;
pub mod export;
pub mod haptics;
pub mod lifecycle;
pub mod math;
pub mod import;
pub mod incoming;
pub mod ipc_body;
pub mod notebook;
pub mod open_files;
pub mod pdf;
pub mod platform;
pub mod recognition;
pub mod recognize;
pub mod practice;
pub mod semantics;
pub mod settings;
pub mod share;
pub mod speech;
pub mod thumbnails;
#[cfg(desktop)]
pub mod updater;
#[cfg(desktop)]
pub mod windows;

/// The error a desktop-only command returns on Android and iOS. Every command exists on both
/// platforms so the frontend has one IPC surface.
#[cfg_attr(desktop, allow(dead_code))]
pub const NOT_ON_MOBILE: &str = "Not available on this device.";

/// Mobile has no in-app updater: the store updates the app.
#[cfg(mobile)]
pub mod updater {
    use serde::Serialize;

    use super::NOT_ON_MOBILE;

    /// Same shape as the desktop `UpdateCheck`.
    #[derive(Debug, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateCheck {
        pub configured: bool,
        pub available: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub notes: Option<String>,
    }

    #[tauri::command]
    pub async fn check_for_update() -> Result<UpdateCheck, String> {
        Ok(UpdateCheck { configured: false, available: false, version: None, notes: None })
    }

    #[tauri::command]
    pub async fn install_update(expected_version: String) -> Result<(), String> {
        let _ = expected_version;
        Err(NOT_ON_MOBILE.into())
    }

    #[tauri::command]
    pub fn relaunch() -> Result<(), String> {
        Err(NOT_ON_MOBILE.into())
    }

    #[tauri::command]
    pub fn report_flush(token: u64, ok: bool) -> Result<(), String> {
        let _ = (token, ok);
        Ok(())
    }
}

/// Mobile shows one page at a time in the single window: no page windows.
#[cfg(mobile)]
pub mod windows {
    use crate::windows::PageWindowInfo;

    use super::NOT_ON_MOBILE;

    #[tauri::command]
    pub async fn open_page_window(page_id: String) -> Result<String, String> {
        let _ = page_id;
        Err(NOT_ON_MOBILE.into())
    }

    #[tauri::command]
    pub async fn focus_page_window(page_id: String) -> Result<bool, String> {
        let _ = page_id;
        Err(NOT_ON_MOBILE.into())
    }

    #[tauri::command]
    pub fn list_page_windows() -> Vec<PageWindowInfo> {
        Vec::new()
    }
}
