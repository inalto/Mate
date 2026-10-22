//! PDF import plumbing: validating and storing a PDF picked, dropped or opened through the `.pdf`
//! file association, and the pending-open-file handshake with the frontend.
//!
//! A PDF opened from the OS arrives as a path in `argv` at startup, as the argv of a second
//! instance forwarded by the single-instance plugin while running (Windows/Linux: every open starts
//! a new process), or as `RunEvent::Opened` (macOS). Until the frontend asks for it
//! (`take_pending_open_file`) the path is parked; after that, later opens are emitted as the
//! `incoming-file-open` event instead.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use mate_core::assets::{self, AssetInfo, AssetKind};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

/// Largest PDF accepted for import.
pub const MAX_PDF_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

pub const TOO_LARGE: &str = "PDF is larger than 50 MiB.";
pub const NOT_A_PDF: &str = "That file is not a PDF.";

/// Event carrying the path of a PDF opened while the app is running.
pub const INCOMING_FILE_OPEN: &str = "incoming-file-open";

/// A PDF path waiting for the frontend, and whether the frontend has started asking.
#[derive(Default)]
pub struct PendingOpenFile {
    inner: Mutex<(Option<String>, bool)>,
}

impl PendingOpenFile {
    pub fn new(path: Option<String>) -> PendingOpenFile {
        PendingOpenFile { inner: Mutex::new((path, false)) }
    }

    /// The parked path (once); marks the frontend as listening.
    pub fn take(&self) -> Option<String> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.1 = true;
        g.0.take()
    }

    /// Park `path` unless the frontend is already listening; true when it should be emitted instead.
    pub fn offer(&self, path: String) -> bool {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.1 {
            return true;
        }
        g.0 = Some(path);
        false
    }
}

/// True when `path` names a `.pdf` file (by extension, case-insensitive).
fn is_pdf_path(path: &str) -> bool {
    Path::new(path).extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// The first `.pdf` argument after the program name, made absolute against `cwd` (the working
/// directory of the process that received the arguments) when relative.
pub fn pdf_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Option<String> {
    let arg = args.into_iter().skip(1).find(|a| is_pdf_path(a))?;
    let path = Path::new(&arg);
    Some(if path.is_absolute() { arg } else { cwd.join(path).to_string_lossy().into_owned() })
}

/// Validates the PDF at `path` (size before reading, then content sniffing) and stores it in `dir`.
pub fn store_pdf(dir: &Path, path: &Path) -> Result<AssetInfo, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(NOT_A_PDF.into());
    }
    if meta.len() > MAX_PDF_IMPORT_BYTES {
        return Err(TOO_LARGE.into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if assets::sniff(&bytes) != Some(AssetKind::Pdf) {
        return Err(NOT_A_PDF.into());
    }
    assets::save_asset(dir, &bytes, AssetKind::Pdf).map_err(|e| e.to_string())
}

/// Stores the PDF at `path` (dialog pick, drop or file association) in the asset store.
#[tauri::command]
pub fn read_shared_pdf(state: State<'_, AppState>, path: String) -> Result<AssetInfo, String> {
    store_pdf(&state.data_dir.join("assets"), Path::new(&path))
}

/// The PDF the app was opened with, once; afterwards opens arrive as `incoming-file-open`.
#[tauri::command]
pub fn take_pending_open_file(pending: State<'_, PendingOpenFile>) -> Option<String> {
    pending.take()
}

/// Hand a PDF opened while running to the frontend (parked if it is not listening yet).
pub fn file_opened(app: &AppHandle, path: String) {
    if !is_pdf_path(&path) {
        return;
    }
    if let Some(pending) = app.try_state::<PendingOpenFile>()
        && pending.offer(path.clone())
    {
        let _ = app.emit(INCOMING_FILE_OPEN, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mate-pdf-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rejects_over_50mib() {
        let d = root("big");
        let big = d.join("big.pdf");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_PDF_IMPORT_BYTES + 1).unwrap(); // sparse: cheap to create
        drop(f);
        assert_eq!(store_pdf(&d.join("assets"), &big), Err(TOO_LARGE.to_string()));
        assert!(!d.join("assets").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stores_a_pdf_and_rejects_other_content() {
        let d = root("ok");
        let pdf = d.join("a.pdf");
        fs::write(&pdf, b"%PDF-1.7\n%stub\n").unwrap();
        let fake = d.join("b.pdf");
        fs::write(&fake, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]).unwrap();
        let info = store_pdf(&d.join("assets"), &pdf).unwrap();
        assert_eq!(info.mime, "application/pdf");
        assert!(info.path.exists());
        assert_eq!(store_pdf(&d.join("assets"), &fake), Err(NOT_A_PDF.to_string()));
        assert_eq!(store_pdf(&d.join("assets"), &d), Err(NOT_A_PDF.to_string()));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn picks_the_pdf_argument() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let cwd = std::env::temp_dir();
        let abs = cwd.join("x").join("Doc.PDF").to_string_lossy().into_owned();
        assert_eq!(pdf_from_args(args(&["mate.exe", &abs]), &cwd), Some(abs.clone()));
        assert_eq!(pdf_from_args(args(&["mate.pdf"]), &cwd), None);
        assert_eq!(pdf_from_args(args(&["mate", "--flag", "notes.txt"]), &cwd), None);
    }

    #[test]
    fn resolves_a_relative_pdf_argument_against_the_cwd() {
        // A second instance started from a shell hands over its own working directory.
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let cwd = std::env::temp_dir().join("docs");
        let want = cwd.join("sub").join("Notes.pdf").to_string_lossy().into_owned();
        let rel = Path::new("sub").join("Notes.pdf").to_string_lossy().into_owned();
        assert_eq!(pdf_from_args(args(&["mate.exe", &rel]), &cwd), Some(want));
    }

    #[test]
    fn pending_file_is_parked_until_taken_then_emitted() {
        let p = PendingOpenFile::new(Some("a.pdf".into()));
        assert!(!p.offer("b.pdf".into())); // not listening yet: replaces the parked one
        assert_eq!(p.take(), Some("b.pdf".into()));
        assert_eq!(p.take(), None);
        assert!(p.offer("c.pdf".into())); // listening now: emit
        assert_eq!(p.take(), None);
    }
}
