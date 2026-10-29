use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mate_core::archive::{
    BackupReport, ImportReport, MAX_ARCHIVE_BYTES, SkippedBook, export_unit, import_archive,
    wipe_local_data, write_backup,
};
use mate_core::settings::Settings;
use mate_core::storage::Storage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::export::{
    after_export, ask_save_path, export_filename, save_and_share, write_atomically,
    write_atomically_with,
};
use super::incoming::materialize;
use crate::state::AppState;

/// Exports a unit (book) and the assets its elements reference to a `.mate` file chosen in a
/// save dialog (mobile: written to `exports/` and shared). `None` if cancelled.
#[tauri::command]
pub async fn export_unit_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    unit_id: String,
) -> Result<Option<String>, String> {
    let (bytes, title) = {
        let storage = state.storage.lock().map_err(|e| e.to_string())?;
        let title = storage
            .list_tree()
            .map_err(|e| e.to_string())?
            .units
            .into_iter()
            .find(|u| u.id == unit_id)
            .map(|u| u.title)
            .unwrap_or_default();
        (
            export_unit(&storage, &unit_id, &state.data_dir.join("assets"))
                .map_err(|e| e.to_string())?,
            title,
        )
    };
    save_and_share(app, export_filename(&title, "mate"), &bytes).await
}

/// Imports a `.mate` file chosen in an open dialog as a new book (its assets go to the asset
/// store under new ids). `None` if cancelled.
#[tauri::command]
pub async fn import_unit_archive(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ImportReport>, String> {
    let data_dir = state.data_dir.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter("Mate archive", &["mate"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        // Android hands back a `content://` URI; it is copied into `incoming/` first.
        let picked = match picked {
            tauri_plugin_dialog::FilePath::Url(url) => url.as_str().to_string(),
            tauri_plugin_dialog::FilePath::Path(path) => path.to_string_lossy().into_owned(),
        };
        materialize(&app, &data_dir, &picked).map(Some)
    })
    .await
    .map_err(|e| e.to_string())??;
    let Some(path) = picked else {
        return Ok(None);
    };
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_ARCHIVE_BYTES as u64 {
        return Err("archive is larger than 512 MiB".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let mut storage = state.storage.lock().map_err(|e| e.to_string())?;
    import_archive(&mut storage, &bytes, &state.data_dir.join("assets"))
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Name of the library backup: `mate-backup-YYYY-MM-DD.zip`.
fn backup_filename() -> String {
    format!("mate-backup-{}.zip", &mate_core::model::now_iso()[..10])
}

/// Streams a backup of every book into `file` (buffered); see [`write_backup`].
fn write_backup_file(
    storage: &Storage,
    assets_dir: &Path,
    file: &mut fs::File,
) -> Result<BackupReport, String> {
    let (out, report) = write_backup(storage, assets_dir, io::BufWriter::new(file))
        .map_err(|e| e.to_string())?;
    out.into_inner().map_err(|e| e.to_string())?;
    Ok(report)
}

/// A backup written to disk, with the books it had to leave out.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSaved {
    pub path: String,
    pub skipped: Vec<SkippedBook>,
}

/// Zips every book (one `.mate` archive each) to a file chosen in a save dialog, streaming it to
/// disk one book at a time. A book too large for an archive is left out and listed in the
/// result. `None` if cancelled.
#[tauri::command]
pub async fn export_backup(app: AppHandle) -> Result<Option<BackupSaved>, String> {
    let Some(path) = ask_save_path(app.clone(), backup_filename()).await? else {
        return Ok(None);
    };
    let handle = app.clone();
    let target = path.clone();
    // Written under the storage lock (off the async runtime), so the backup is one snapshot.
    let report = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let storage = state.storage.lock().map_err(|e| e.to_string())?;
        let assets_dir = state.data_dir.join("assets");
        write_atomically_with(&target, |f| write_backup_file(&storage, &assets_dir, f))
    })
    .await
    .map_err(|e| e.to_string())??;
    if !report.skipped.is_empty() {
        log::warn!("backup: left out {} book(s) over the archive cap", report.skipped.len());
    }
    after_export(&app, &path).await?;
    Ok(Some(BackupSaved {
        path: path.to_string_lossy().into_owned(),
        skipped: report.skipped,
    }))
}

/// Left in the data directory when a reset could not delete everything or had to leave books out
/// of the recovery zip; the next launch tells the user where their backup is and what it lacks.
pub const RESET_MARKER: &str = "reset-incomplete.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetIncomplete {
    /// The recovery zip written before anything was deleted.
    pub recovery_path: String,
    /// Why deleting local data failed; `None` when it succeeded (the marker is only there for
    /// `skipped`).
    #[serde(default)]
    pub error: Option<String>,
    /// Books too large for the recovery zip (deleted with the rest).
    #[serde(default)]
    pub skipped: Vec<SkippedBook>,
}

/// What [`run_reset`] did once it passed the point of no return.
#[derive(Debug, PartialEq)]
pub struct ResetOutcome {
    pub recovery: PathBuf,
    pub wipe_error: Option<String>,
    /// Books left out of the recovery zip for being too large.
    pub skipped: Vec<SkippedBook>,
}

/// The reset itself, with the deleter injectable. Errors (nothing deleted, app keeps running on
/// its real database) only come from before the storage swap. After the swap the app is running
/// on an empty in-memory database, so a failed wipe is reported in the outcome and in a marker
/// file instead of as an error: the caller must restart either way.
#[cfg_attr(mobile, allow(dead_code))]
pub fn run_reset(
    data_dir: &Path,
    storage: &Mutex<Storage>,
    settings: &Mutex<Settings>,
    wipe: &dyn Fn(&Path) -> io::Result<()>,
) -> Result<ResetOutcome, String> {
    run_reset_with(data_dir, storage, settings, wipe, &|| {}, &|_| {})
}

/// [`run_reset`] with a hook that runs before the wipe, once the recovery zip is written and the
/// storage has been swapped out (mobile hands the zip to the share sheet there).
#[cfg_attr(desktop, allow(dead_code))]
pub fn run_reset_sharing(
    data_dir: &Path,
    storage: &Mutex<Storage>,
    settings: &Mutex<Settings>,
    wipe: &dyn Fn(&Path) -> io::Result<()>,
    before_wipe: &dyn Fn(&Path),
) -> Result<ResetOutcome, String> {
    run_reset_with(data_dir, storage, settings, wipe, &|| {}, before_wipe)
}

/// [`run_reset`] with a hook that runs while the zip is being built (tests use it to probe the
/// storage lock) and one that gets the recovery path just before the wipe.
fn run_reset_with(
    data_dir: &Path,
    storage: &Mutex<Storage>,
    settings: &Mutex<Settings>,
    wipe: &dyn Fn(&Path) -> io::Result<()>,
    during_zip: &dyn Fn(),
    before_wipe: &dyn Fn(&Path),
) -> Result<ResetOutcome, String> {
    // The storage lock is held from the snapshot through the swap, so no write can land after the
    // snapshot and then be deleted without being in the recovery zip.
    // A book too large for an archive does not block the reset: it is left out of the zip and
    // reported (on the next launch, through the marker).
    let mut guard = storage.lock().map_err(|e| e.to_string())?;
    let stamp = mate_core::model::now_iso().replace([':', '.'], "-");
    let recovery = data_dir.join(format!("mate-recovery-{stamp}.zip"));
    let assets_dir = data_dir.join("assets");
    let report = write_atomically_with(&recovery, |f| {
        during_zip();
        write_backup_file(&guard, &assets_dir, f)
    })?;
    let skipped = report.skipped;
    // Drop the file connection so the database can be deleted (Windows keeps it locked).
    *guard = Storage::open_in_memory().map_err(|e| e.to_string())?;
    drop(guard);
    // Past the point of no return: a panic here must not skip the restart, so it is treated like
    // a failed wipe.
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| before_wipe(&recovery))).is_err() {
        log::warn!("reset: the pre-wipe hook panicked");
    }
    let wipe_error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wipe(data_dir).err().map(|e| e.to_string())
    }))
    .unwrap_or_else(|_| Some("deleting local data panicked".to_string()));
    if let Ok(mut s) = settings.lock() {
        *s = Settings::default();
    }
    if wipe_error.is_some() || !skipped.is_empty() {
        let marker = ResetIncomplete {
            recovery_path: recovery.to_string_lossy().into_owned(),
            error: wipe_error.clone(),
            skipped: skipped.clone(),
        };
        if let Ok(json) = serde_json::to_vec_pretty(&marker) {
            let _ = write_atomically(&data_dir.join(RESET_MARKER), &json);
        }
    }
    Ok(ResetOutcome {
        recovery,
        wipe_error,
        skipped,
    })
}

/// Deletes all local data (books, pages, assets, settings) and restarts the app into the
/// first-run flow. A backup zip is written (and synced) next to the database first; if that
/// fails nothing is deleted. Once data may have been touched the app always restarts; a failed
/// wipe leaves `reset-incomplete.json` for the next launch. `confirm` must be `"RESET"`.
/// Returns only on error.
#[cfg(desktop)]
#[tauri::command]
pub async fn reset_local_data(app: AppHandle, confirm: String) -> Result<(), String> {
    if confirm != "RESET" {
        return Err("reset was not confirmed".into());
    }
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        run_reset(&state.data_dir, &state.storage, &state.settings, &wipe_local_data)
    })
    .await
    .map_err(|e| e.to_string())??;
    log::info!(
        "local data reset (wipe error: {:?}); recovery backup at {}",
        outcome.wipe_error,
        outcome.recovery.display()
    );
    app.restart()
}

/// Mobile reset: the app-private data directory is out of the user's reach, so before the wipe
/// a copy of the recovery zip is staged in `exports/` and handed to the share sheet (the plugin
/// copies it to the cache, so wiping `exports/` afterwards does not break the share). Android
/// cannot restart an app, so it exits and the user reopens it into the first-run flow. The
/// original recovery zip stays next to the database, as on desktop. Returns only on error.
#[cfg(mobile)]
#[tauri::command]
pub async fn reset_local_data(app: AppHandle, confirm: String) -> Result<(), String> {
    if confirm != "RESET" {
        return Err("reset was not confirmed".into());
    }
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let data_dir = state.data_dir.clone();
        let share = |recovery: &Path| {
            let Some(name) = recovery.file_name() else {
                return;
            };
            let exports = data_dir.join(super::export::EXPORTS_DIR);
            let shared = exports.join(name);
            let staged = fs::create_dir_all(&exports).and_then(|()| fs::copy(recovery, &shared));
            if let Err(e) = staged {
                log::warn!("reset: could not stage the recovery zip for sharing: {e}");
                return;
            }
            let result = tauri::async_runtime::block_on(super::export::share_file(
                &handle,
                &shared,
                "application/zip",
            ));
            if let Err(e) = result {
                log::warn!("reset: could not share the recovery zip: {e}");
            }
        };
        run_reset_sharing(&data_dir, &state.storage, &state.settings, &wipe_local_data, &share)
    })
    .await
    .map_err(|e| e.to_string())??;
    log::info!(
        "local data reset (wipe error: {:?}); recovery backup at {}",
        outcome.wipe_error,
        outcome.recovery.display()
    );
    app.exit(0);
    Ok(())
}

/// Returns (and clears) the marker left by a reset that could not delete everything.
#[tauri::command]
pub fn take_reset_incomplete(state: State<'_, AppState>) -> Option<ResetIncomplete> {
    let path = state.data_dir.join(RESET_MARKER);
    let marker = serde_json::from_slice(&fs::read(&path).ok()?).ok();
    let _ = fs::remove_file(&path);
    marker
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mate-reset-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn fixture(dir: &Path) -> (Mutex<Storage>, Mutex<Settings>) {
        let mut st = Storage::open(&dir.join("mate.db")).unwrap();
        let now = mate_core::model::now_iso();
        st.upsert_unit(&mate_core::model::Unit {
            id: "u1".into(),
            title: "Maths".into(),
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
        let settings = Settings {
            theme: "dark".into(),
            ..Settings::default()
        };
        (Mutex::new(st), Mutex::new(settings))
    }

    #[test]
    fn reset_writes_recovery_then_wipes() {
        let dir = tmp("ok");
        let (st, se) = fixture(&dir);
        let out = run_reset(&dir, &st, &se, &wipe_local_data).unwrap();
        assert!(out.recovery.exists());
        assert_eq!(out.wipe_error, None);
        assert!(!dir.join("mate.db").exists());
        assert!(!dir.join(RESET_MARKER).exists());
        assert_eq!(se.lock().unwrap().theme, "light");
        assert!(st.lock().unwrap().list_tree().unwrap().units.is_empty());
    }

    #[test]
    fn failed_wipe_is_reported_with_a_marker_not_an_error() {
        let dir = tmp("fail");
        let (st, se) = fixture(&dir);
        let locked = |_: &Path| -> io::Result<()> { Err(io::Error::other("asset is locked")) };
        let out = run_reset(&dir, &st, &se, &locked).unwrap();
        assert_eq!(out.wipe_error.as_deref(), Some("asset is locked"));
        assert!(out.recovery.exists());
        let marker: ResetIncomplete =
            serde_json::from_slice(&fs::read(dir.join(RESET_MARKER)).unwrap()).unwrap();
        assert_eq!(marker.recovery_path, out.recovery.to_string_lossy());
        assert_eq!(marker.error.as_deref(), Some("asset is locked"));
        assert!(marker.skipped.is_empty());
    }

    #[test]
    fn an_old_marker_without_skipped_books_still_reads() {
        let marker: ResetIncomplete =
            serde_json::from_str(r#"{"recoveryPath":"r.zip","error":"locked"}"#).unwrap();
        assert_eq!(marker.error.as_deref(), Some("locked"));
        assert!(marker.skipped.is_empty());
    }

    #[test]
    fn the_recovery_zip_is_a_readable_backup() {
        let dir = tmp("zip");
        let (st, se) = fixture(&dir);
        let out = run_reset(&dir, &st, &se, &wipe_local_data).unwrap();
        assert!(out.skipped.is_empty());
        let zip = zip::ZipArchive::new(fs::File::open(&out.recovery).unwrap()).unwrap();
        let names: Vec<&str> = zip.file_names().collect();
        assert!(names.contains(&"backup.json"), "{names:?}");
        assert!(names.contains(&"books/01-maths.mate"), "{names:?}");
        assert!(!dir.join(format!("{}.tmp", out.recovery.file_name().unwrap().to_string_lossy())).exists());
    }

    #[test]
    fn nothing_is_deleted_when_the_recovery_zip_cannot_be_written() {
        let dir = tmp("norecovery");
        let (st, se) = fixture(&dir);
        let gone = dir.join("missing-subdir");
        let wiped = Mutex::new(false);
        let wipe = |_: &Path| -> io::Result<()> {
            *wiped.lock().unwrap() = true;
            Ok(())
        };
        assert!(run_reset(&gone, &st, &se, &wipe).is_err());
        assert!(!*wiped.lock().unwrap());
        assert_eq!(se.lock().unwrap().theme, "dark");
        assert_eq!(st.lock().unwrap().list_tree().unwrap().units.len(), 1);
    }

    #[test]
    fn storage_stays_locked_from_snapshot_to_swap() {
        let dir = tmp("lock");
        let (st, se) = fixture(&dir);
        let probe = || {
            assert!(
                matches!(st.try_lock(), Err(std::sync::TryLockError::WouldBlock)),
                "storage must stay locked while the zip is built"
            );
        };
        run_reset_with(&dir, &st, &se, &wipe_local_data, &probe, &|_| {}).unwrap();
    }

    #[test]
    fn a_panicking_wiper_is_reported_not_propagated() {
        let dir = tmp("panic");
        let (st, se) = fixture(&dir);
        let boom = |_: &Path| -> io::Result<()> { panic!("boom") };
        let out = run_reset(&dir, &st, &se, &boom).unwrap();
        assert_eq!(out.wipe_error.as_deref(), Some("deleting local data panicked"));
        assert!(dir.join(RESET_MARKER).exists());
        assert_eq!(se.lock().unwrap().theme, "light");
    }

    #[test]
    fn the_pre_wipe_hook_sees_the_recovery_zip_before_anything_is_deleted() {
        let dir = tmp("hook");
        let (st, se) = fixture(&dir);
        fs::create_dir_all(dir.join("exports")).unwrap();
        fs::create_dir_all(dir.join("incoming")).unwrap();
        let seen = Mutex::new(None);
        let hook = |recovery: &Path| {
            *seen.lock().unwrap() = Some((recovery.exists(), dir.join("mate.db").exists()));
        };
        let out = run_reset_sharing(&dir, &st, &se, &wipe_local_data, &hook).unwrap();
        assert_eq!(*seen.lock().unwrap(), Some((true, true)));
        assert!(out.recovery.exists());
        assert!(!dir.join("mate.db").exists());
        assert!(!dir.join("exports").exists());
        assert!(!dir.join("incoming").exists());
    }
}
