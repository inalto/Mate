//! "Open with" for notebook files: the paths of GoodNotes, Notability, OneNote, Freenotes and
//! Samsung Notes files, and of Mate archives (`.mate`), the OS hands to Mate, and the handshake
//! with the frontend.
//!
//! Like PDFs (see [`super::pdf`]), such a file arrives as `argv` at startup, as the argv of a
//! second instance forwarded by the single-instance plugin while running, or as `RunEvent::Opened`
//! (macOS). Until the frontend asks (`take_pending_import_files`) the paths are parked; after that
//! they are emitted as `import://file-opened`. This module is the one place that routes an opened
//! path: `.pdf` goes to the existing PDF path, import extensions to the import dialog.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::pdf;

/// Event carrying the notebook files opened while the app is running.
pub const FILE_OPENED_EVENT: &str = "import://file-opened";

/// Extensions (lower case) of the formats the import dialog reads (`mate`: a Mate archive).
pub const IMPORT_EXTENSIONS: &[&str] =
    &["goodnotes", "note", "one", "onepkg", "freenotes", "freenotesv2", "freebackup", "sdocx", "mate"];

/// True when `path` has one of the [`IMPORT_EXTENSIONS`] (case-insensitive).
pub fn is_import_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMPORT_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// True when `path` is a Mate archive (`.mate`, case-insensitive): imported as a whole book.
pub fn is_mate_path(path: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mate"))
}

/// Payload of [`FILE_OPENED_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileOpened {
    pub paths: Vec<String>,
}

/// Every import-format argument after the program name, made absolute against `cwd` when relative.
pub fn import_paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| is_import_path(a))
        .map(|a| {
            let p = Path::new(&a);
            if p.is_absolute() { a } else { cwd.join(p).to_string_lossy().into_owned() }
        })
        .collect()
}

/// Import files waiting for the frontend, and whether the frontend has started asking.
#[derive(Default)]
pub struct PendingImportFiles {
    inner: Mutex<(Vec<String>, bool)>,
}

impl PendingImportFiles {
    pub fn new(paths: Vec<String>) -> PendingImportFiles {
        PendingImportFiles { inner: Mutex::new((paths, false)) }
    }

    /// The parked paths (once); marks the frontend as listening.
    pub fn take(&self) -> Vec<String> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.1 = true;
        std::mem::take(&mut g.0)
    }

    /// The event to emit for `paths`, or `None` after parking them because the frontend is not
    /// listening yet.
    pub fn offer(&self, paths: Vec<String>) -> Option<FileOpened> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.1 {
            return Some(FileOpened { paths });
        }
        g.0.extend(paths);
        None
    }
}

/// The import files the app was opened with (once); afterwards opens arrive as
/// `import://file-opened`.
#[tauri::command]
pub fn take_pending_import_files(pending: State<'_, PendingImportFiles>) -> Vec<String> {
    pending.take()
}

/// What to do with the arguments of a (second) instance: emit the returned event, if any. Pure so
/// it can be tested without a running app.
#[cfg(desktop)] // A second instance exists on desktop only (single-instance plugin).
pub fn route_args(
    pending: &PendingImportFiles,
    args: impl IntoIterator<Item = String>,
    cwd: &Path,
) -> Option<FileOpened> {
    let paths: Vec<String> =
        import_paths_from_args(args, cwd).into_iter().filter(|p| Path::new(p).is_file()).collect();
    if paths.is_empty() { None } else { pending.offer(paths) }
}

/// Route the arguments forwarded by a second instance: the first PDF as before, and all import
/// files together.
#[cfg(desktop)] // A second instance exists on desktop only (single-instance plugin).
pub fn args_opened(app: &AppHandle, argv: Vec<String>, cwd: &Path) {
    if let Some(path) = pdf::pdf_from_args(argv.clone(), cwd)
        && Path::new(&path).is_file()
    {
        pdf::file_opened(app, path);
    }
    if let Some(pending) = app.try_state::<PendingImportFiles>()
        && let Some(event) = route_args(&pending, argv, cwd)
    {
        let _ = app.emit(FILE_OPENED_EVENT, event);
    }
}

/// Route one path opened through the OS (macOS `RunEvent::Opened`).
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub fn file_opened(app: &AppHandle, path: String) {
    if is_import_path(&path) {
        if let Some(pending) = app.try_state::<PendingImportFiles>()
            && let Some(event) = pending.offer(vec![path])
        {
            let _ = app.emit(FILE_OPENED_EVENT, event);
        }
    } else {
        pdf::file_opened(app, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mate-open-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn open_with_while_running_emits_event() {
        let d = temp("run");
        let file = d.join("Maths.GoodNotes");
        fs::write(&file, b"PK").unwrap();
        let path = file.to_string_lossy().into_owned();
        let pending = PendingImportFiles::new(vec![]);
        pending.take(); // the frontend is listening
        let event = route_args(&pending, args(&["mate.exe", &path, "--flag", "x.pdf"]), &d);
        assert_eq!(event, Some(FileOpened { paths: vec![path.clone()] }));
        assert_eq!(serde_json::to_value(event.unwrap()).unwrap(), serde_json::json!({ "paths": [path] }));
        assert!(pending.take().is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn files_opened_before_the_frontend_listens_are_parked_once() {
        let d = temp("park");
        let a = d.join("a.note");
        let b = d.join("b.sdocx");
        fs::write(&a, b"x").unwrap();
        fs::write(&b, b"x").unwrap();
        let (pa, pb) = (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned());
        let pending = PendingImportFiles::new(vec![]);
        assert_eq!(route_args(&pending, args(&["mate", &pa]), &d), None);
        assert_eq!(route_args(&pending, args(&["mate", "b.sdocx"]), &d), None); // relative: resolved
        assert_eq!(pending.take(), vec![pa, pb]);
        assert!(pending.take().is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_import_extensions_and_existing_files_are_routed() {
        let cwd = std::env::temp_dir();
        for ext in IMPORT_EXTENSIONS {
            assert!(is_import_path(&format!("x.{}", ext.to_uppercase())), "{ext}");
        }
        assert!(!is_import_path("x.pdf"));
        assert!(is_import_path("x.mate") && is_import_path("/books/Maths.MATE"));
        assert!(is_mate_path("x.Mate") && !is_mate_path("x.note") && !is_mate_path("mate"));
        assert!(!is_import_path("goodnotes"));
        assert_eq!(import_paths_from_args(args(&["a.note"]), &cwd), Vec::<String>::new()); // program name
        let pending = PendingImportFiles::new(vec![]);
        assert_eq!(route_args(&pending, args(&["mate", "missing.goodnotes"]), &cwd), None);
        assert!(pending.take().is_empty());
    }
}
