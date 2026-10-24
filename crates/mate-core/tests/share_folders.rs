//! Synced-folder detection over a fake environment: one test per rule.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use mate_core::share::folders::{Env, SyncFolder, SyncService, detect};
use mate_core::share::{safe_file_name, unique_archive_path};

#[derive(Default)]
struct FakeEnv {
    vars: HashMap<String, String>,
    home: Option<PathBuf>,
    files: HashMap<PathBuf, String>,
    dirs: HashSet<PathBuf>,
    volumes: Vec<(PathBuf, String)>,
}

impl FakeEnv {
    fn home(p: &str) -> FakeEnv {
        FakeEnv {
            home: Some(PathBuf::from(p)),
            ..FakeEnv::default()
        }
    }
    fn var(mut self, k: &str, v: &str) -> Self {
        self.vars.insert(k.into(), v.into());
        self
    }
    fn file(mut self, p: impl AsRef<Path>, body: &str) -> Self {
        self.files.insert(p.as_ref().to_path_buf(), body.into());
        self
    }
    fn dir(mut self, p: impl AsRef<Path>) -> Self {
        self.dirs.insert(p.as_ref().to_path_buf());
        self
    }
    fn volume(mut self, root: &str, label: &str) -> Self {
        self.volumes.push((PathBuf::from(root), label.into()));
        self
    }
}

impl Env for FakeEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
    fn home(&self) -> Option<PathBuf> {
        self.home.clone()
    }
    fn read(&self, path: &Path) -> Option<String> {
        self.files.get(path).cloned()
    }
    fn exists(&self, path: &Path) -> bool {
        self.dirs.contains(path)
    }
    fn list_dir(&self, path: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = self
            .dirs
            .iter()
            .filter(|d| d.parent() == Some(path))
            .cloned()
            .collect();
        v.sort();
        v
    }
    fn volumes(&self) -> Vec<(PathBuf, String)> {
        self.volumes.clone()
    }
}

fn folder(service: SyncService, label: &str, path: impl AsRef<Path>) -> SyncFolder {
    SyncFolder {
        service,
        label: label.into(),
        path: path.as_ref().to_string_lossy().into_owned(),
    }
}

#[test]
fn nothing_installed_finds_nothing() {
    assert!(detect(&FakeEnv::home("/home/u")).is_empty());
    assert!(detect(&FakeEnv::default()).is_empty());
}

#[test]
fn dropbox_from_info_json_in_appdata_localappdata_and_home() {
    let info = r#"{"personal":{"path":"/home/u/Dropbox","host":1},"business":{"path":"/home/u/Dropbox (Acme)"}}"#;
    let env = FakeEnv::home("/home/u")
        .file(
            Path::new("/home/u").join(".dropbox").join("info.json"),
            info,
        )
        .dir("/home/u/Dropbox")
        .dir("/home/u/Dropbox (Acme)");
    assert_eq!(
        detect(&env),
        vec![
            folder(SyncService::Dropbox, "Dropbox", "/home/u/Dropbox"),
            folder(
                SyncService::Dropbox,
                "Dropbox (business)",
                "/home/u/Dropbox (Acme)"
            ),
        ]
    );

    let env = FakeEnv::home("/h")
        .var("APPDATA", "/h/AppData/Roaming")
        .file(
            Path::new("/h/AppData/Roaming")
                .join("Dropbox")
                .join("info.json"),
            r#"{"personal":{"path":"/h/Dropbox"}}"#,
        )
        .dir("/h/Dropbox");
    assert_eq!(
        detect(&env),
        vec![folder(SyncService::Dropbox, "Dropbox", "/h/Dropbox")]
    );

    let env = FakeEnv::home("/h")
        .var("LOCALAPPDATA", "/h/AppData/Local")
        .file(
            Path::new("/h/AppData/Local")
                .join("Dropbox")
                .join("info.json"),
            r#"{"business":{"path":"/h/Work"}}"#,
        )
        .dir("/h/Work");
    assert_eq!(
        detect(&env),
        vec![folder(
            SyncService::Dropbox,
            "Dropbox (business)",
            "/h/Work"
        )]
    );
}

#[test]
fn dropbox_bad_json_is_ignored() {
    let env = FakeEnv::home("/h")
        .file(Path::new("/h").join(".dropbox").join("info.json"), "{oops")
        .dir("/h/Dropbox");
    assert!(detect(&env).is_empty());
}

#[test]
fn google_drive_from_volume_label_prefers_my_drive() {
    let env = FakeEnv::default()
        .volume("G:\\", "Google Drive")
        .dir(Path::new("G:\\").join("My Drive"))
        .volume("D:\\", "Data")
        .dir("D:\\");
    assert_eq!(
        detect(&env),
        vec![folder(
            SyncService::GoogleDrive,
            "Google Drive",
            Path::new("G:\\").join("My Drive")
        )]
    );
    // An older layout without "My Drive": the drive root.
    let env = FakeEnv::default()
        .volume("H:\\", "google drive")
        .dir("H:\\");
    assert_eq!(
        detect(&env),
        vec![folder(SyncService::GoogleDrive, "Google Drive", "H:\\")]
    );
}

#[test]
fn google_drive_from_macos_cloud_storage() {
    let cs = Path::new("/Users/u").join("Library").join("CloudStorage");
    let gd = cs.join("GoogleDrive-ann@example.com");
    let env = FakeEnv::home("/Users/u")
        .dir(&cs)
        .dir(&gd)
        .dir(gd.join("My Drive"))
        .dir(cs.join("Other"));
    assert_eq!(
        detect(&env),
        vec![folder(
            SyncService::GoogleDrive,
            "Google Drive (ann@example.com)",
            gd.join("My Drive")
        )]
    );
}

#[test]
fn onedrive_from_env_vars_deduplicated() {
    let env = FakeEnv::home("C:\\Users\\u")
        .var("OneDrive", "C:\\Users\\u\\OneDrive")
        .var("OneDriveConsumer", "C:\\Users\\u\\OneDrive")
        .var("OneDriveCommercial", "C:\\Users\\u\\OneDrive - Acme")
        .dir("C:\\Users\\u\\OneDrive")
        .dir("C:\\Users\\u\\OneDrive - Acme");
    assert_eq!(
        detect(&env),
        vec![
            folder(SyncService::OneDrive, "OneDrive", "C:\\Users\\u\\OneDrive"),
            folder(
                SyncService::OneDrive,
                "OneDrive (Acme)",
                "C:\\Users\\u\\OneDrive - Acme"
            ),
        ]
    );
}

#[test]
fn onedrive_from_macos_cloud_storage() {
    let cs = Path::new("/Users/u").join("Library").join("CloudStorage");
    let env = FakeEnv::home("/Users/u")
        .dir(&cs)
        .dir(cs.join("OneDrive-Personal"))
        .dir(cs.join("OneDrive-Acme"));
    assert_eq!(
        detect(&env),
        vec![
            folder(
                SyncService::OneDrive,
                "OneDrive (Acme)",
                cs.join("OneDrive-Acme")
            ),
            folder(
                SyncService::OneDrive,
                "OneDrive",
                cs.join("OneDrive-Personal")
            ),
        ]
    );
}

#[test]
fn icloud_on_macos_and_windows() {
    let mac = Path::new("/Users/u")
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs");
    let env = FakeEnv::home("/Users/u").dir(&mac);
    assert_eq!(
        detect(&env),
        vec![folder(SyncService::ICloud, "iCloud Drive", &mac)]
    );
    let win = Path::new("C:\\Users\\u").join("iCloudDrive");
    let env = FakeEnv::home("C:\\Users\\u").dir(&win);
    assert_eq!(
        detect(&env),
        vec![folder(SyncService::ICloud, "iCloud Drive", &win)]
    );
}

#[test]
fn nextcloud_from_cfg_folder_entries() {
    let cfg = "[General]\nfoo=bar\n\n[Accounts]\n0\\Folders\\1\\localPath=/home/u/Nextcloud/\n0\\Folders\\1\\paused=false\n1\\Folders\\2\\localPath=/home/u/Work cloud/\nversion=2\n";
    let env = FakeEnv::home("/home/u")
        .file(
            Path::new("/home/u")
                .join(".config")
                .join("Nextcloud")
                .join("nextcloud.cfg"),
            cfg,
        )
        .dir("/home/u/Nextcloud")
        .dir("/home/u/Work cloud");
    assert_eq!(
        detect(&env),
        vec![
            folder(
                SyncService::Nextcloud,
                "Nextcloud (Nextcloud)",
                "/home/u/Nextcloud"
            ),
            folder(
                SyncService::Nextcloud,
                "Nextcloud (Work cloud)",
                "/home/u/Work cloud"
            ),
        ]
    );
    let env = FakeEnv::home("/h")
        .var("APPDATA", "/h/Roaming")
        .file(
            Path::new("/h/Roaming")
                .join("Nextcloud")
                .join("nextcloud.cfg"),
            "0\\Folders\\1\\localPath=/h/Nextcloud/\r\n",
        )
        .dir("/h/Nextcloud");
    assert_eq!(
        detect(&env),
        vec![folder(SyncService::Nextcloud, "Nextcloud", "/h/Nextcloud")]
    );
    let env = FakeEnv::home("/Users/u")
        .file(
            Path::new("/Users/u")
                .join("Library")
                .join("Preferences")
                .join("Nextcloud")
                .join("nextcloud.cfg"),
            "0\\Folders\\1\\localPath=/Users/u/Nextcloud\n",
        )
        .dir("/Users/u/Nextcloud");
    assert_eq!(
        detect(&env),
        vec![folder(
            SyncService::Nextcloud,
            "Nextcloud",
            "/Users/u/Nextcloud"
        )]
    );
}

#[test]
fn folders_listed_but_missing_on_disk_are_dropped() {
    let env = FakeEnv::home("/h")
        .file(
            Path::new("/h").join(".dropbox").join("info.json"),
            r#"{"personal":{"path":"/h/Dropbox"}}"#,
        )
        .var("OneDrive", "/h/OneDrive")
        .file(
            Path::new("/h")
                .join(".config")
                .join("Nextcloud")
                .join("nextcloud.cfg"),
            "0\\Folders\\1\\localPath=/h/Nextcloud/\n",
        )
        .volume("G:\\", "Google Drive");
    assert!(detect(&env).is_empty());
}

#[test]
fn serialises_as_the_frontend_expects() {
    let json =
        serde_json::to_value(folder(SyncService::GoogleDrive, "Google Drive", "/g")).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "service": "googledrive", "label": "Google Drive", "path": "/g" })
    );
    for (s, name) in [
        (SyncService::Dropbox, "dropbox"),
        (SyncService::OneDrive, "onedrive"),
        (SyncService::ICloud, "icloud"),
        (SyncService::Nextcloud, "nextcloud"),
    ] {
        assert_eq!(serde_json::to_value(s).unwrap(), name);
    }
}

#[test]
fn safe_file_name_strips_reserved_characters() {
    assert_eq!(
        safe_file_name("Maths: ch. 1/2 <draft>?"),
        "Maths ch. 12 draft"
    );
    assert_eq!(safe_file_name("  a\\b*c\"d|e  "), "abcde");
    assert_eq!(safe_file_name(""), "Book");
    assert_eq!(safe_file_name(" /:*? "), "Book");
    assert_eq!(safe_file_name("..."), "Book");
    assert_eq!(safe_file_name("Tab\there"), "Tabhere");
    assert_eq!(safe_file_name(&"x".repeat(300)).chars().count(), 120);
}

#[test]
fn unique_archive_path_counts_up() {
    let dir = std::env::temp_dir().join(format!("mate-share-unique-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(unique_archive_path(&dir, "Maths"), dir.join("Maths.mate"));
    std::fs::write(dir.join("Maths.mate"), b"x").unwrap();
    assert_eq!(
        unique_archive_path(&dir, "Maths"),
        dir.join("Maths (2).mate")
    );
    std::fs::write(dir.join("Maths (2).mate"), b"x").unwrap();
    assert_eq!(
        unique_archive_path(&dir, "Maths"),
        dir.join("Maths (3).mate")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_real_machine_can_be_scanned() {
    // Whatever is installed here, detection must not fail and every result must exist.
    for f in detect(&mate_core::share::folders::OsEnv) {
        assert!(Path::new(&f.path).is_dir(), "{f:?}");
    }
}
