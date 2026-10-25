//! What this build runs on, so the frontend can hide desktop-only features on mobile.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// True on Android and iOS builds.
    pub mobile: bool,
    /// `std::env::consts::OS`: "windows", "macos", "linux", "android", "ios".
    pub os: String,
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo { mobile: cfg!(mobile), os: std::env::consts::OS.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_info_reports_this_build() {
        let info = platform_info();
        assert_eq!(info.mobile, cfg!(mobile));
        assert_eq!(info.os, std::env::consts::OS);
    }
}
