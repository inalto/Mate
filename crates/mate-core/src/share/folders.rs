//! Finding the folders cloud-sync apps keep in sync on this machine: Dropbox, Google Drive for
//! desktop, OneDrive, iCloud Drive and the Nextcloud desktop client. Detection reads only local
//! configuration through an injected [`Env`], so every rule is tested with a fake; a folder a
//! client lists but that is missing on disk is dropped.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The sync app behind a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncService {
    Dropbox,
    GoogleDrive,
    OneDrive,
    #[serde(rename = "icloud")]
    ICloud,
    Nextcloud,
}

/// A synced folder a book can be saved into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncFolder {
    pub service: SyncService,
    /// What the user sees, e.g. "Dropbox" or "OneDrive (Acme)".
    pub label: String,
    pub path: String,
}

/// What detection may look at.
pub trait Env {
    /// An environment variable (unset or empty is `None`).
    fn var(&self, name: &str) -> Option<String>;
    fn home(&self) -> Option<PathBuf>;
    /// A small text file's content.
    fn read(&self, path: &Path) -> Option<String>;
    /// True when `path` is an existing directory.
    fn exists(&self, path: &Path) -> bool;
    /// The entries of a directory (empty when it cannot be read).
    fn list_dir(&self, path: &Path) -> Vec<PathBuf>;
    /// Mounted volumes: root path and label (Windows drive letters; empty elsewhere).
    fn volumes(&self) -> Vec<(PathBuf, String)>;
}

/// Every synced folder found, in service order (Dropbox, Google Drive, OneDrive, iCloud Drive,
/// Nextcloud), each path once.
pub fn detect(env: &dyn Env) -> Vec<SyncFolder> {
    let mut found: Vec<(SyncService, String, PathBuf)> = Vec::new();
    dropbox(env, &mut found);
    google_drive(env, &mut found);
    onedrive(env, &mut found);
    icloud(env, &mut found);
    nextcloud(env, &mut found);
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|(_, _, p)| env.exists(p) && seen.insert(p.clone()))
        .map(|(service, label, path)| SyncFolder {
            service,
            label,
            path: path.to_string_lossy().into_owned(),
        })
        .collect()
}

type Found = Vec<(SyncService, String, PathBuf)>;

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `~/Library/CloudStorage/<prefix>*` folders (macOS), sorted.
fn cloud_storage(env: &dyn Env, prefix: &str) -> Vec<PathBuf> {
    let Some(home) = env.home() else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = env
        .list_dir(&home.join("Library").join("CloudStorage"))
        .into_iter()
        .filter(|p| file_name(p).starts_with(prefix))
        .collect();
    dirs.sort();
    dirs
}

/// Dropbox writes `info.json` (`{"personal": {"path": …}, "business": {"path": …}}`) under
/// `%APPDATA%\Dropbox`, `%LOCALAPPDATA%\Dropbox` or `~/.dropbox`.
fn dropbox(env: &dyn Env, found: &mut Found) {
    let mut candidates: Vec<PathBuf> = ["APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(|v| env.var(v))
        .map(|d| PathBuf::from(d).join("Dropbox").join("info.json"))
        .collect();
    if let Some(home) = env.home() {
        candidates.push(home.join(".dropbox").join("info.json"));
    }
    for file in candidates {
        let Some(info) = env
            .read(&file)
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        else {
            continue;
        };
        for (key, label) in [("personal", "Dropbox"), ("business", "Dropbox (business)")] {
            if let Some(path) = info
                .get(key)
                .and_then(|a| a.get("path"))
                .and_then(|p| p.as_str())
            {
                found.push((SyncService::Dropbox, label.to_owned(), PathBuf::from(path)));
            }
        }
    }
}

/// The "My Drive" folder inside a Google Drive root, or the root itself when it has none.
fn my_drive(env: &dyn Env, root: PathBuf) -> PathBuf {
    let inner = root.join("My Drive");
    if env.exists(&inner) { inner } else { root }
}

/// Google Drive for desktop: a drive whose volume label is "Google Drive" (Windows), or
/// `~/Library/CloudStorage/GoogleDrive-<account>` (macOS).
fn google_drive(env: &dyn Env, found: &mut Found) {
    for (root, label) in env.volumes() {
        if label.trim().eq_ignore_ascii_case("Google Drive") {
            found.push((
                SyncService::GoogleDrive,
                "Google Drive".into(),
                my_drive(env, root),
            ));
        }
    }
    for dir in cloud_storage(env, "GoogleDrive-") {
        let account = file_name(&dir)["GoogleDrive-".len()..].to_owned();
        let label = if account.is_empty() {
            "Google Drive".to_owned()
        } else {
            format!("Google Drive ({account})")
        };
        found.push((SyncService::GoogleDrive, label, my_drive(env, dir)));
    }
}

/// "OneDrive", or "OneDrive (<organisation>)" for a folder named `OneDrive - Acme` (Windows) or
/// `OneDrive-Acme` (macOS; `OneDrive-Personal` is the personal one).
fn onedrive_label(dir: &Path) -> String {
    let name = file_name(dir);
    let rest = name
        .strip_prefix("OneDrive")
        .unwrap_or("")
        .trim_start_matches([' ', '-'])
        .trim();
    if rest.is_empty() || rest.eq_ignore_ascii_case("Personal") {
        "OneDrive".to_owned()
    } else {
        format!("OneDrive ({rest})")
    }
}

/// OneDrive: the `OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` environment variables
/// (Windows) and `~/Library/CloudStorage/OneDrive-*` (macOS).
fn onedrive(env: &dyn Env, found: &mut Found) {
    let dirs = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(|v| env.var(v))
        .map(PathBuf::from)
        .chain(cloud_storage(env, "OneDrive-"));
    for dir in dirs {
        found.push((SyncService::OneDrive, onedrive_label(&dir), dir));
    }
}

/// iCloud Drive: `~/Library/Mobile Documents/com~apple~CloudDocs` (macOS) or
/// `%USERPROFILE%\iCloudDrive` (Windows).
fn icloud(env: &dyn Env, found: &mut Found) {
    let Some(home) = env.home() else { return };
    for dir in [
        home.join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs"),
        home.join("iCloudDrive"),
    ] {
        found.push((SyncService::ICloud, "iCloud Drive".into(), dir));
    }
}

/// The `N\Folders\M\localPath=` values of a Nextcloud client `nextcloud.cfg`.
fn nextcloud_paths(cfg: &str) -> Vec<PathBuf> {
    cfg.lines()
        .filter_map(|line| line.trim().split_once('='))
        .filter(|(key, _)| key.contains("\\Folders\\") && key.ends_with("\\localPath"))
        .map(|(_, value)| {
            let v = value.trim();
            let trimmed = v.trim_end_matches(['/', '\\']);
            // Keep a bare root ("/" or "C:/") whole.
            if trimmed.is_empty() || trimmed.ends_with(':') {
                PathBuf::from(v)
            } else {
                PathBuf::from(trimmed)
            }
        })
        .collect()
}

/// The Nextcloud desktop client's sync folders, from `nextcloud.cfg` in `%APPDATA%\Nextcloud`
/// (Windows), `~/Library/Preferences/Nextcloud` (macOS) or `$XDG_CONFIG_HOME/Nextcloud`
/// (default `~/.config/Nextcloud`, Linux).
fn nextcloud(env: &dyn Env, found: &mut Found) {
    let mut configs: Vec<PathBuf> = Vec::new();
    if let Some(d) = env.var("APPDATA") {
        configs.push(PathBuf::from(d).join("Nextcloud"));
    }
    if let Some(d) = env.var("XDG_CONFIG_HOME") {
        configs.push(PathBuf::from(d).join("Nextcloud"));
    }
    if let Some(home) = env.home() {
        configs.push(home.join("Library").join("Preferences").join("Nextcloud"));
        configs.push(home.join(".config").join("Nextcloud"));
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    for cfg in configs
        .iter()
        .filter_map(|d| env.read(&d.join("nextcloud.cfg")))
    {
        for p in nextcloud_paths(&cfg) {
            if env.exists(&p) && !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    let several = dirs.len() > 1;
    for dir in dirs {
        let label = if several {
            format!("Nextcloud ({})", file_name(&dir))
        } else {
            "Nextcloud".to_owned()
        };
        found.push((SyncService::Nextcloud, label, dir));
    }
}

/// The real machine.
pub struct OsEnv;

impl Env for OsEnv {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.trim().is_empty())
    }

    fn home(&self) -> Option<PathBuf> {
        self.var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
    }

    fn read(&self, path: &Path) -> Option<String> {
        // Configuration files are small; anything large is not one of them.
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }

    fn exists(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn list_dir(&self, path: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(path)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default()
    }

    fn volumes(&self) -> Vec<(PathBuf, String)> {
        os_volumes()
    }
}

#[cfg(windows)]
fn os_volumes() -> Vec<(PathBuf, String)> {
    use windows::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    use windows::core::PCWSTR;
    // GetDriveTypeW results (winbase.h).
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_NO_ROOT_DIR: u32 = 1;

    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", char::from(b'A' + i as u8));
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // Probing empty removable or optical drives is slow and can prompt for a disk.
        if matches!(kind, DRIVE_REMOVABLE | DRIVE_CDROM | DRIVE_NO_ROOT_DIR) {
            continue;
        }
        let mut name = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                PCWSTR(wide.as_ptr()),
                Some(&mut name),
                None,
                None,
                None,
                None,
            )
        };
        if ok.is_ok() {
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            out.push((PathBuf::from(&root), String::from_utf16_lossy(&name[..len])));
        }
    }
    out
}

#[cfg(not(windows))]
fn os_volumes() -> Vec<(PathBuf, String)> {
    Vec::new()
}
