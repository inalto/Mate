//! Importing notebooks from other apps: sniffing the picked files, then reading, parsing and
//! placing each one (off the async runtime) with progress events, a deadline for parsing and
//! another for placing, and a cancel flag. Parsing and placement live in `mate_core::import`;
//! this module only walks the files, reports progress and turns the two error types
//! (`ImportError`, `StorageError`) into one sentence for the user.
//!
//! Placement takes the storage lock once per page (through `StorageAccess` on the mutex), so
//! other storage commands run between pages while a large file is placed.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::incoming::materialize;
use super::open_files::{is_import_path, is_mate_path};
use mate_core::archive::{MAX_ARCHIVE_BYTES, import_archive};
use mate_core::import::place::{ImportReport, PlaceControl, PlaceTarget, place_document_with};
use mate_core::import::{
    IMPORT_DEADLINE, ImportDocument, ImportError, ImportLimits, ImportSource, fingerprint, max_file_bytes, parse,
    sniff,
};
use mate_core::model::ElementType;
use mate_core::storage::{Storage, StorageError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

/// Progress event name.
pub const PROGRESS_EVENT: &str = "import://progress";

/// Shown when a file runs into the per-file deadline.
pub const TOOK_TOO_LONG: &str = "Importing this file took too long, so it was stopped. Try a smaller file.";
const CANCELLED: &str = "The import was cancelled.";
const UNREADABLE: &str = "This file could not be read.";

/// The largest file any format accepts; bigger files are refused without reading them.
const LARGEST_FILE: u64 = 256 * 1024 * 1024;

/// Set by `cancel_import`; checked between files and phases and between placed pages (a parse in
/// progress stops at its deadline).
#[derive(Default)]
pub struct ImportControl {
    cancel: AtomicBool,
    running: AtomicBool,
}

/// Held while an import runs; dropping it allows the next one.
pub struct RunGuard<'a>(&'a AtomicBool);

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ImportControl {
    /// Claims the single import slot and clears the cancel flag; an error sentence when an import
    /// is already running.
    pub fn begin(&self) -> Result<RunGuard<'_>, String> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ALREADY_RUNNING.to_string())?;
        self.cancel.store(false, Ordering::SeqCst);
        Ok(RunGuard(&self.running))
    }
}

pub const ALREADY_RUNNING: &str = "An import is already running.";
/// Most files one call accepts.
pub const MAX_PATHS: usize = 50;
/// How much of a file is read to rule out obvious non-matches before reading all of it.
pub const HEAD_BYTES: usize = 64 * 1024;
const NOT_IMPORTABLE: &str = "This is not a notebook file Mate can import (unsupported file extension).";
/// Display name of a `.mate` file in the import dialog.
pub const MATE_ARCHIVE: &str = "Mate archive";
const NOT_A_MATE_ARCHIVE: &str = "This is not a Mate archive.";
const MATE_TOO_LARGE: &str = "Mate archives over 512 MiB are not imported.";
/// The note a `.mate` import adds to its report.
pub const ONE_BOOK_IMPORTED: &str = "1 book imported.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SniffStatus {
    Ok,
    Rejected,
}

/// What `sniff_import_files` found out about one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SniffResult {
    pub path: String,
    pub filename: String,
    pub size: u64,
    pub status: SniffStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ImportSource>,
    /// Display name of `source`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileStatus {
    Ok,
    Failed,
}

/// The outcome of importing one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileResult {
    pub path: String,
    pub status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ImportReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Reading,
    Parsing,
    Placing,
}

/// Payload of `import://progress`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub path: String,
    pub phase: Phase,
    pub pages_done: usize,
    pub pages_total: usize,
}

/// The user-readable sentence for an import error.
pub fn import_error_message(e: &ImportError) -> String {
    e.to_string()
}

/// The user-readable sentence for a storage error raised while placing pages.
pub fn storage_error_message(e: &StorageError) -> String {
    match e {
        StorageError::NotFound(_) => "That book no longer exists. Choose another destination.".into(),
        StorageError::Limit(why) => format!("The file could not be imported: {why}."),
        other => {
            // The technical detail goes to the log, not to the user.
            eprintln!("mate: import could not save pages: {other}");
            "The pages could not be saved. Try again, and if it keeps failing restart Mate.".into()
        }
    }
}

/// The parser, behind a trait so the deadline handling can be tested without real notebook files.
pub trait Importer {
    fn parse(&self, bytes: &[u8], filename: &str, limits: &ImportLimits) -> Result<ImportDocument, ImportError>;
}

/// `mate_core::import::parse`.
pub struct CoreImporter;

impl Importer for CoreImporter {
    fn parse(&self, bytes: &[u8], filename: &str, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
        parse(bytes, filename, limits)
    }
}

fn filename_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// The path must have an import extension and name an existing regular file.
pub fn check_path(path: &str) -> Result<(), String> {
    if !is_import_path(path) {
        return Err(NOT_IMPORTABLE.into());
    }
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(()),
        _ => Err(UNREADABLE.into()),
    }
}

/// The first [`HEAD_BYTES`] of `path`.
fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::new();
    fs::File::open(path)?.take(HEAD_BYTES as u64).read_to_end(&mut head)?;
    Ok(head)
}

/// True when the first bytes could start a format Mate reads (a zip, a OneNote section or a cabinet).
fn plausible_head(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04")
        || head.starts_with(b"PK\x05\x06")
        || head.starts_with(b"MSCF")
        || head.starts_with(&mate_core::import::ONE_MAGIC)
}

/// Reads `path` after checking it is a file within the size every format accepts.
fn read_source(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|_| UNREADABLE.to_string())?;
    if !meta.is_file() {
        return Err(UNREADABLE.into());
    }
    if meta.len() > LARGEST_FILE {
        return Err(import_error_message(&ImportError::Limit(format!(
            "files over {} MiB are not imported",
            LARGEST_FILE / (1024 * 1024)
        ))));
    }
    fs::read(path).map_err(|_| UNREADABLE.to_string())
}

/// Detects the format of the file at `path` from its content.
pub fn sniff_path(path: &str) -> SniffResult {
    let p = Path::new(path);
    let filename = filename_of(p);
    let size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let rejected = |reason: String| SniffResult {
        path: path.to_owned(),
        filename: filename.clone(),
        size,
        status: SniffStatus::Rejected,
        source: None,
        source_name: None,
        reason: Some(reason),
    };
    if let Err(reason) = check_path(path) {
        return rejected(reason);
    }
    if is_mate_path(path) {
        return match read_head(p) {
            Ok(_) if size > MAX_ARCHIVE_BYTES as u64 => rejected(MATE_TOO_LARGE.into()),
            Ok(head) if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") => SniffResult {
                path: path.to_owned(),
                filename: filename.clone(),
                size,
                status: SniffStatus::Ok,
                source: None,
                source_name: Some(MATE_ARCHIVE.to_owned()),
                reason: None,
            },
            Ok(_) => rejected(NOT_A_MATE_ARCHIVE.into()),
            Err(_) => rejected(UNREADABLE.into()),
        };
    }
    // Rule out obvious non-matches from the head before reading a large file in full.
    match read_head(p) {
        Ok(head) if !plausible_head(&head) => {
            return rejected(
                sniff(&head, &filename).err().map_or_else(|| NOT_IMPORTABLE.to_owned(), |e| import_error_message(&e)),
            );
        }
        Ok(_) => {}
        Err(_) => return rejected(UNREADABLE.into()),
    }
    let bytes = match read_source(p) {
        Ok(b) => b,
        Err(reason) => return rejected(reason),
    };
    match sniff(&bytes, &filename) {
        Ok(source) if size > max_file_bytes(source) => rejected(import_error_message(&ImportError::Limit(format!(
            "{} files over {} MiB are not imported",
            source.display_name(),
            max_file_bytes(source) / (1024 * 1024)
        )))),
        Ok(source) => SniffResult {
            path: path.to_owned(),
            filename,
            size,
            status: SniffStatus::Ok,
            source: Some(source),
            source_name: Some(source.display_name().to_owned()),
            reason: None,
        },
        Err(e) => rejected(import_error_message(&e)),
    }
}

/// Everything `import_one` needs besides the file.
pub struct Job<'a> {
    pub storage: &'a std::sync::Mutex<Storage>,
    pub assets_dir: &'a Path,
    pub cancel: &'a AtomicBool,
    /// Time allowed for parsing, and again for placing.
    pub deadline: Duration,
}

/// Reads, parses and places the file at `path`; returns the report or a sentence for the user.
pub fn import_one(
    importer: &dyn Importer,
    job: &Job<'_>,
    path: &str,
    target: PlaceTarget,
    progress: &dyn Fn(Progress),
) -> Result<ImportReport, String> {
    let say = |phase, done, total| {
        progress(Progress { path: path.to_owned(), phase, pages_done: done, pages_total: total })
    };
    let cancelled = || job.cancel.load(Ordering::SeqCst);
    check_path(path)?;
    if is_mate_path(path) {
        return import_mate(job, path, progress);
    }
    let deadline = Instant::now() + job.deadline;
    let p = Path::new(path);
    let filename = filename_of(p);

    say(Phase::Reading, 0, 0);
    let bytes = read_source(p)?;
    if cancelled() {
        return Err(CANCELLED.into());
    }

    say(Phase::Parsing, 0, 0);
    let source = sniff(&bytes, &filename).map_err(|e| import_error_message(&e))?;
    let limits = ImportLimits { deadline: Some(deadline), ..ImportLimits::for_source(source) };
    let doc = importer.parse(&bytes, &filename, &limits).map_err(|e| match e {
        // The core reports a passed deadline as `Limit`; a stub or future parser may say `Cancelled`.
        ImportError::Cancelled if !cancelled() => TOOK_TOO_LONG.to_owned(),
        ImportError::Limit(_) if Instant::now() >= deadline => TOOK_TOO_LONG.to_owned(),
        other => import_error_message(&other),
    })?;
    if cancelled() {
        return Err(CANCELLED.into());
    }

    let total = doc.page_count();
    say(Phase::Placing, 0, total);
    let fp = fingerprint::file_fingerprint(&bytes);
    let place_deadline = Instant::now() + job.deadline;
    let place_limits = ImportLimits { deadline: Some(place_deadline), ..ImportLimits::default() };
    let on_page = |done, total| say(Phase::Placing, done, total);
    let control = PlaceControl { limits: &place_limits, cancel: job.cancel, progress: &on_page };
    let mut access = job.storage;
    place_document_with(&mut access, &doc, target, job.assets_dir, &fp, &control).map_err(|e| {
        // Stopped before any page was placed.
        if cancelled() {
            CANCELLED.to_owned()
        } else if Instant::now() >= place_deadline {
            TOOK_TOO_LONG.to_owned()
        } else {
            storage_error_message(&e)
        }
    })
}

/// Imports a Mate archive as a new book through `mate_core::archive` (the target does not apply:
/// an archive is a whole book). The report counts its pages and elements and says "1 book
/// imported.".
fn import_mate(job: &Job<'_>, path: &str, progress: &dyn Fn(Progress)) -> Result<ImportReport, String> {
    let say = |phase, done, total| {
        progress(Progress { path: path.to_owned(), phase, pages_done: done, pages_total: total })
    };
    say(Phase::Reading, 0, 0);
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|_| UNREADABLE.to_string())?;
    if meta.len() > MAX_ARCHIVE_BYTES as u64 {
        return Err(MATE_TOO_LARGE.into());
    }
    let bytes = fs::read(p).map_err(|_| UNREADABLE.to_string())?;
    if job.cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    say(Phase::Placing, 0, 0);
    let mut storage = job.storage.lock().map_err(|_| UNREADABLE.to_string())?;
    let imported = import_archive(&mut storage, &bytes, job.assets_dir).map_err(|e| storage_error_message(&e))?;
    let report = mate_report(&storage, &imported).map_err(|e| storage_error_message(&e))?;
    drop(storage);
    say(Phase::Placing, report.pages_imported, report.pages_imported);
    Ok(report)
}

/// The import dialog's report for an imported archive.
fn mate_report(storage: &Storage, imported: &mate_core::archive::ImportReport) -> Result<ImportReport, StorageError> {
    let tree = storage.list_tree()?;
    let section_ids: Vec<String> =
        tree.sections.iter().filter(|s| s.unit_id == imported.unit_id).map(|s| s.id.clone()).collect();
    let mut report = ImportReport {
        unit_id: imported.unit_id.clone(),
        pages_imported: imported.pages,
        elements_skipped_limit: imported.skipped,
        warnings: vec![ONE_BOOK_IMPORTED.to_owned()],
        ..ImportReport::default()
    };
    for page in tree.pages.iter().filter(|p| section_ids.contains(&p.section_id)) {
        for e in storage.load_elements(&page.id)? {
            match e.r#type {
                ElementType::Stroke => report.strokes += 1,
                ElementType::Text | ElementType::TextBox => report.texts += 1,
                ElementType::Image => report.images += 1,
                _ => {}
            }
        }
    }
    report.section_ids = section_ids;
    Ok(report)
}

fn too_many() -> String {
    format!("Choose at most {MAX_PATHS} files at a time.")
}

/// The result for a picked entry that could not be read at all (logged; the user sees [`UNREADABLE`]).
fn unreadable(path: &str, error: &str) -> SniffResult {
    log::warn!("mate: could not read {path}: {error}");
    SniffResult {
        path: path.to_owned(),
        filename: filename_of(Path::new(path)),
        size: 0,
        status: SniffStatus::Rejected,
        source: None,
        source_name: None,
        reason: Some(UNREADABLE.into()),
    }
}

/// Detects the format of each picked or dropped file.
#[tauri::command]
/// A picked `content://` URI (Android) is materialised first; its result then carries the
/// stashed path, which is what `import_files` receives next.
pub async fn sniff_import_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<SniffResult>, String> {
    if paths.len() > MAX_PATHS {
        return Err(too_many());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app.state::<AppState>().data_dir.clone();
        paths
            .iter()
            .map(|p| match materialize(&app, &data_dir, p) {
                Ok(path) => sniff_path(&path.to_string_lossy()),
                Err(e) => unreadable(p, &e),
            })
            .collect()
    })
        .await
        .map_err(|e| e.to_string())
}

/// Imports each file in turn (each in its own blocking task). With `NewUnit`, the first file that
/// succeeds creates the book and the following files go into it.
#[tauri::command]
pub async fn import_files(
    app: AppHandle,
    paths: Vec<String>,
    target: PlaceTarget,
) -> Result<Vec<ImportFileResult>, String> {
    if paths.len() > MAX_PATHS {
        return Err(too_many());
    }
    let control_state = app.state::<ImportControl>();
    let _slot = control_state.begin()?;
    let mut target = target;
    let mut results = Vec::with_capacity(paths.len());
    for path in paths {
        if app.state::<ImportControl>().cancel.load(Ordering::SeqCst) {
            results.push(ImportFileResult {
                path,
                status: FileStatus::Failed,
                report: None,
                error: Some(CANCELLED.into()),
            });
            continue;
        }
        let (app2, path2, target2) = (app.clone(), path.clone(), target.clone());
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let state: State<'_, AppState> = app2.state();
            // Normally a no-op: the sniff already materialised picked URIs.
            let local = materialize(&app2, &state.data_dir, &path2)?;
            let path2 = local.to_string_lossy().into_owned();
            let control: State<'_, ImportControl> = app2.state();
            let assets = state.data_dir.join("assets");
            let job = Job {
                storage: &state.storage,
                assets_dir: &assets,
                cancel: &control.cancel,
                deadline: IMPORT_DEADLINE,
            };
            let emit = |p: Progress| {
                let _ = app2.emit(PROGRESS_EVENT, p);
            };
            import_one(&CoreImporter, &job, &path2, target2, &emit).map(|report| (report, path2))
        })
        .await
        .map_err(|e| e.to_string())?;
        results.push(match outcome {
            Ok((report, local)) => {
                // A Mate archive is a book of its own; the next files do not go into it.
                if matches!(target, PlaceTarget::NewUnit { .. }) && !is_mate_path(&local) {
                    target = PlaceTarget::ExistingUnit { unit_id: report.unit_id.clone() };
                }
                ImportFileResult { path, status: FileStatus::Ok, report: Some(report), error: None }
            }
            Err(error) => ImportFileResult { path, status: FileStatus::Failed, report: None, error: Some(error) },
        });
    }
    Ok(results)
}

/// Stops the running import: files not yet started are skipped and the current one is abandoned
/// at its next phase boundary.
#[tauri::command]
pub fn cancel_import(control: State<'_, ImportControl>) {
    control.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::import::{ImportPage, ImportSection};
    use mate_core::model::PageMode;
    use std::sync::Mutex;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mate-import-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// An empty zip: no markers, so the extension decides the format.
    fn bare_zip(path: &Path) {
        fs::write(path, b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0").unwrap();
    }

    #[test]
    fn sniff_command_rejects_unknown_with_reason() {
        let d = temp("sniff");
        let txt = d.join("notes.note");
        fs::write(&txt, b"hello").unwrap();
        let r = sniff_path(&txt.to_string_lossy());
        assert_eq!(r.status, SniffStatus::Rejected);
        assert_eq!(r.filename, "notes.note");
        assert_eq!(r.size, 5);
        assert_eq!(r.source, None);
        assert!(r.reason.as_deref().unwrap().contains("not a format Mate can import"), "{:?}", r.reason);

        let gn = d.join("Maths.goodnotes");
        bare_zip(&gn);
        let ok = sniff_path(&gn.to_string_lossy());
        assert_eq!(ok.status, SniffStatus::Ok);
        assert_eq!(ok.source, Some(ImportSource::GoodNotes));
        assert_eq!(ok.reason, None);
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["source"], "good-notes");

        let missing = sniff_path(&d.join("gone.note").to_string_lossy());
        assert_eq!(missing.status, SniffStatus::Rejected);
        assert_eq!(missing.reason.as_deref(), Some(UNREADABLE));
        let _ = fs::remove_dir_all(&d);
    }

    /// Sleeps until the deadline it was given, then gives up like a parser that checks it.
    struct Sleepy;
    impl Importer for Sleepy {
        fn parse(&self, _: &[u8], _: &str, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
            let until = limits.deadline.expect("a deadline is always set");
            while Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(ImportError::Cancelled)
        }
    }

    struct OneBlankPage;
    impl Importer for OneBlankPage {
        fn parse(&self, _: &[u8], _: &str, _: &ImportLimits) -> Result<ImportDocument, ImportError> {
            Ok(ImportDocument {
                source: ImportSource::GoodNotes,
                title: "Maths".into(),
                default_page_mode: PageMode::Page,
                sections: vec![ImportSection {
                    source_id: "s".into(),
                    title: "S".into(),
                    pages: vec![ImportPage {
                        source_id: "p1".into(),
                        width: 600.0,
                        height: 800.0,
                        ..Default::default()
                    }],
                }],
            })
        }
    }

    #[test]
    fn import_respects_deadline() {
        let d = temp("deadline");
        let file = d.join("Slow.goodnotes");
        bare_zip(&file);
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_millis(60) };
        let started = Instant::now();
        let seen = std::cell::RefCell::new(Vec::new());
        let err = import_one(&Sleepy, &job, &file.to_string_lossy(), PlaceTarget::NewUnit { title: None }, &|p| {
            seen.borrow_mut().push(p.phase)
        })
        .unwrap_err();
        assert_eq!(err, TOOK_TOO_LONG);
        assert!(started.elapsed() >= Duration::from_millis(60));
        assert_eq!(*seen.borrow(), vec![Phase::Reading, Phase::Parsing]);
        assert!(storage.lock().unwrap().list_tree().unwrap().units.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn imports_with_progress_and_reports_cancellation() {
        let d = temp("flow");
        let file = d.join("Maths.goodnotes");
        bare_zip(&file);
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(5) };
        let seen = std::cell::RefCell::new(Vec::new());
        let path = file.to_string_lossy().into_owned();
        let report = import_one(&OneBlankPage, &job, &path, PlaceTarget::NewUnit { title: Some("Maths".into()) }, &|p| {
            seen.borrow_mut().push((p.phase, p.pages_done, p.pages_total))
        })
        .unwrap();
        assert_eq!(report.pages_imported, 1);
        assert_eq!(
            *seen.borrow(),
            vec![(Phase::Reading, 0, 0), (Phase::Parsing, 0, 0), (Phase::Placing, 0, 1), (Phase::Placing, 1, 1)]
        );
        // The same file into the same book again: the page is recognised.
        let again = import_one(
            &OneBlankPage,
            &job,
            &path,
            PlaceTarget::ExistingUnit { unit_id: report.unit_id.clone() },
            &|_| {},
        )
        .unwrap();
        assert_eq!((again.pages_imported, again.pages_skipped_duplicate), (0, 1));

        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            import_one(&OneBlankPage, &job, &path, PlaceTarget::NewUnit { title: None }, &|_| {}).unwrap_err(),
            CANCELLED
        );
        let _ = fs::remove_dir_all(&d);
    }

    /// `n` blank pages.
    struct BlankPages(usize);
    impl Importer for BlankPages {
        fn parse(&self, _: &[u8], _: &str, _: &ImportLimits) -> Result<ImportDocument, ImportError> {
            let mut doc = OneBlankPage.parse(&[], "", &ImportLimits::default())?;
            let page = doc.sections[0].pages[0].clone();
            doc.sections[0].pages =
                (0..self.0).map(|i| ImportPage { source_id: format!("p{i}"), ..page.clone() }).collect();
            Ok(doc)
        }
    }

    #[test]
    fn placement_releases_the_storage_lock_between_pages() {
        use std::sync::atomic::AtomicUsize;
        let d = temp("lock");
        let file = d.join("Big.goodnotes");
        bare_zip(&file);
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(30) };
        let path = file.to_string_lossy().into_owned();
        let placed = AtomicUsize::new(0);
        let placed_when_locked = std::thread::scope(|scope| {
            let other = scope.spawn(|| {
                // Another storage command, issued once placement has started.
                while placed.load(Ordering::SeqCst) == 0 {
                    std::thread::sleep(Duration::from_millis(1));
                }
                let units = storage.lock().unwrap().list_tree().unwrap().units.len();
                (placed.load(Ordering::SeqCst), units)
            });
            // 50 pages, each followed by 10 ms of work outside the storage step.
            let report = import_one(&BlankPages(50), &job, &path, PlaceTarget::NewUnit { title: None }, &|p| {
                if p.phase == Phase::Placing && p.pages_done > 0 {
                    placed.store(p.pages_done, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
            .unwrap();
            assert_eq!(report.pages_imported, 50);
            other.join().unwrap()
        });
        // The other command got the lock while pages were still being placed.
        assert!(placed_when_locked.0 < 50, "{placed_when_locked:?}");
        assert_eq!(placed_when_locked.1, 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn placement_stops_on_cancel_between_pages() {
        let d = temp("cancel-pages");
        let file = d.join("Big.goodnotes");
        bare_zip(&file);
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(30) };
        let report = import_one(&BlankPages(20), &job, &file.to_string_lossy(), PlaceTarget::NewUnit { title: None }, &|p| {
            if p.phase == Phase::Placing && p.pages_done == 5 {
                cancel.store(true, Ordering::SeqCst);
            }
        })
        .unwrap();
        assert_eq!(report.pages_imported, 5);
        assert!(report.warnings.iter().any(|w| w.contains("cancelled")), "{:?}", report.warnings);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn commands_reject_non_import_extensions() {
        let d = temp("ext");
        let zip = d.join("sneaky.txt");
        bare_zip(&zip);
        let r = sniff_path(&zip.to_string_lossy());
        assert_eq!(r.status, SniffStatus::Rejected);
        assert!(r.reason.as_deref().unwrap().contains("extension"));
        let dir = d.join("folder.goodnotes");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(sniff_path(&dir.to_string_lossy()).reason.as_deref(), Some(UNREADABLE));

        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(5) };
        let err = import_one(&OneBlankPage, &job, &zip.to_string_lossy(), PlaceTarget::NewUnit { title: None }, &|_| {})
            .unwrap_err();
        assert!(err.contains("extension"));
        assert!(storage.lock().unwrap().list_tree().unwrap().units.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn sniff_reads_head_before_full_file() {
        let d = temp("head");
        let big = d.join("big.note");
        fs::write(&big, vec![b'x'; 5 * 1024 * 1024]).unwrap();
        assert_eq!(read_head(&big).unwrap().len(), HEAD_BYTES);
        assert!(!plausible_head(&read_head(&big).unwrap()));
        let r = sniff_path(&big.to_string_lossy());
        assert_eq!(r.status, SniffStatus::Rejected);
        assert!(r.reason.as_deref().unwrap().contains("not a format Mate can import"));
        assert!(plausible_head(b"PK\x03\x04rest") && plausible_head(b"MSCF"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn mate_archives_are_sniffed_and_imported_as_a_book() {
        let d = temp("mate");
        // A one-page book to export.
        let source = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let gn = d.join("Maths.goodnotes");
        bare_zip(&gn);
        let job = Job { storage: &source, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(5) };
        let target = PlaceTarget::NewUnit { title: Some("Maths".into()) };
        let placed = import_one(&OneBlankPage, &job, &gn.to_string_lossy(), target, &|_| {}).unwrap();
        let bytes =
            mate_core::archive::export_unit(&source.lock().unwrap(), &placed.unit_id, &d.join("assets")).unwrap();
        let file = d.join("Maths.mate");
        fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let sniffed = sniff_path(&path);
        assert_eq!(sniffed.status, SniffStatus::Ok);
        assert_eq!(sniffed.source, None);
        assert_eq!(sniffed.source_name.as_deref(), Some(MATE_ARCHIVE));

        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(5) };
        let seen = std::cell::RefCell::new(Vec::new());
        // The target does not apply: an archive is always a new book.
        let target = PlaceTarget::ExistingUnit { unit_id: "elsewhere".into() };
        let report = import_one(&OneBlankPage, &job, &path, target, &|p| {
            seen.borrow_mut().push((p.phase, p.pages_done, p.pages_total))
        })
        .unwrap();
        assert_eq!(report.pages_imported, 1);
        assert_eq!(report.warnings, vec![ONE_BOOK_IMPORTED.to_string()]);
        assert_eq!(report.section_ids.len(), 1);
        let units = storage.lock().unwrap().list_tree().unwrap().units;
        assert_eq!(units.len(), 1);
        assert_eq!((units[0].id.as_str(), units[0].title.as_str()), (report.unit_id.as_str(), "Maths"));
        assert_eq!(*seen.borrow(), vec![(Phase::Reading, 0, 0), (Phase::Placing, 0, 0), (Phase::Placing, 1, 1)]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_broken_mate_file_is_refused_with_a_sentence() {
        let d = temp("badmate");
        let junk = d.join("junk.mate");
        fs::write(&junk, b"hello").unwrap();
        let r = sniff_path(&junk.to_string_lossy());
        assert_eq!((r.status, r.reason.as_deref()), (SniffStatus::Rejected, Some(NOT_A_MATE_ARCHIVE)));
        let zip = d.join("empty.mate");
        bare_zip(&zip);
        assert_eq!(sniff_path(&zip.to_string_lossy()).status, SniffStatus::Ok);
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let cancel = AtomicBool::new(false);
        let job = Job { storage: &storage, assets_dir: &d, cancel: &cancel, deadline: Duration::from_secs(5) };
        let target = PlaceTarget::NewUnit { title: None };
        let err = import_one(&OneBlankPage, &job, &zip.to_string_lossy(), target, &|_| {}).unwrap_err();
        assert!(err.contains("not a Mate archive"), "{err}");
        assert!(storage.lock().unwrap().list_tree().unwrap().units.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_one_import_runs_at_a_time() {
        let control = ImportControl::default();
        let first = control.begin().unwrap();
        assert_eq!(control.begin().err().as_deref(), Some(ALREADY_RUNNING));
        control.cancel.store(true, Ordering::SeqCst);
        drop(first);
        let _second = control.begin().unwrap();
        assert!(!control.cancel.load(Ordering::SeqCst)); // a new import starts uncancelled
    }

    #[test]
    fn both_error_types_become_sentences() {
        assert_eq!(import_error_message(&ImportError::Cancelled), "The import was cancelled.");
        let json = serde_json::from_str::<u8>("x").unwrap_err();
        assert!(!storage_error_message(&StorageError::Json(json)).to_lowercase().contains("json"));
        assert!(storage_error_message(&StorageError::NotFound("unit x".into())).contains("no longer exists"));
        assert!(
            storage_error_message(&StorageError::Limit("the file has no pages to import".into())).contains("no pages")
        );
    }
}
