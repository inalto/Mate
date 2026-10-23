//! Smoke test for the notebook importers: parses files and places them into a fresh in-memory
//! database, then prints the import report as JSON with timings.
//!
//! ```text
//! cargo run -p mate-core --example import_smoke -- <file> [more files]
//! ```
//!
//! Each file is sniffed, parsed under [`ImportLimits::for_source`] with the 60 second import
//! deadline, and placed into its own empty store with a temporary assets directory. Nothing is
//! written to disk outside that temporary directory, and it is removed at the end. The first
//! file that fails stops the run with exit status 1 and a readable message.
//!
//! Keep real sample notebooks in `docs/import-samples/`. That directory is gitignored (the whole
//! `docs/` tree is), so personal files are never committed.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use mate_core::import::{ImportLimits, PlaceTarget, file_fingerprint, parse, place_document, sniff};
use mate_core::storage::Storage;

fn main() -> ExitCode {
    let paths: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if paths.is_empty() {
        eprintln!("usage: import_smoke <file> [more files]");
        return ExitCode::from(2);
    }
    let mut failed = false;
    for path in &paths {
        println!("== {}", path.display());
        if let Err(message) = run_one(path) {
            eprintln!("error: {}: {message}", path.display());
            failed = true;
            break;
        }
    }
    if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}

/// Imports one file and prints its report. Errors are returned as the message to show.
fn run_one(path: &Path) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read the file ({e})"))?;
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();

    let started = Instant::now();
    let source = sniff(&bytes, filename).map_err(|e| e.to_string())?;
    // `for_source` sets the per-format cap and a deadline 60 s from now; take it right before parsing.
    let limits = ImportLimits::for_source(source);
    let parse_started = Instant::now();
    let document = parse(&bytes, filename, &limits).map_err(|e| e.to_string())?;
    let parse_ms = parse_started.elapsed().as_millis();

    let assets_dir = temp_assets_dir()?;
    let result = place_into_fresh_store(&document, &assets_dir, &file_fingerprint(&bytes));
    let _ = std::fs::remove_dir_all(&assets_dir);
    let report = result?;
    let total_ms = started.elapsed().as_millis();

    println!("source: {} ({} pages)", source.display_name(), document.page_count());
    println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
    println!("timing: parse {parse_ms} ms, total {total_ms} ms");
    Ok(())
}

fn place_into_fresh_store(
    document: &mate_core::import::ImportDocument,
    assets_dir: &Path,
    fingerprint: &str,
) -> Result<mate_core::import::ImportReport, String> {
    let mut storage = Storage::open_in_memory().map_err(|e| format!("could not open a store ({e})"))?;
    place_document(&mut storage, document, PlaceTarget::NewUnit { title: None }, assets_dir, fingerprint)
        .map_err(|e| e.to_string())
}

/// A fresh, empty directory under the system temp dir for this run's image assets.
fn temp_assets_dir() -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("mate-import-smoke-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create a temp directory ({e})"))?;
    Ok(dir)
}
