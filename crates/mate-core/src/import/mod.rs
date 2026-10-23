//! Importing notebooks from other note-taking apps (GoodNotes, Notability, OneNote, Freenotes,
//! Samsung Notes).
//!
//! The pipeline is `sniff` (format detection by content) → `parse` (format module → a neutral
//! [`ImportDocument`]) → [`place_document`] (scaled onto Mate pages, one transaction per page).
//! Parsing never touches storage; every format module works under [`ImportLimits`].
//!
//! Not to be confused with [`crate::archive`], which imports Mate's own `.mate` archives (its
//! `ImportLimits`/`ImportReport` are different types).

pub mod fingerprint;
pub mod model;
pub mod pb;
pub mod place;
pub mod zipsrc;

mod freenotes;
mod goodnotes;
mod notability;
mod onenote;
mod samsung;

use std::io::Cursor;
use std::time::{Duration, Instant};

pub use fingerprint::{element_fingerprint, file_fingerprint, fnv1a64, page_fingerprint};
pub use model::{
    ImportBackground, ImportDocument, ImportImage, ImportPage, ImportPoint, ImportSection,
    ImportSkipped, ImportSource, ImportStroke, ImportText,
};
pub use place::{ImportReport, PlaceTarget, place_document};
pub use zipsrc::ZipSource;
/// OneNote's raw-value → import-model mapping, public for its unit tests.
#[doc(hidden)]
pub use onenote::adapter as onenote_adapter;

/// Most pages one import places; the rest are counted as skipped.
pub const MAX_PAGES_PER_IMPORT: usize = 2000;
/// Most entries a zip-based source may have.
pub const MAX_ZIP_ENTRIES: usize = 20_000;
/// Most bytes a zip-based source may inflate to (declared and actually read).
pub const MAX_UNZIPPED_BYTES: u64 = 1024 * 1024 * 1024;
/// How long one import may take.
pub const IMPORT_DEADLINE: Duration = Duration::from_secs(60);

const MIB: u64 = 1024 * 1024;

/// OneNote section files start with this GUID ({7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}).
pub const ONE_MAGIC: [u8; 16] = [
    0xE4, 0x52, 0x5C, 0x7B, 0x8C, 0xD8, 0xA7, 0x4D, 0xAE, 0xB1, 0x53, 0x78, 0xD0, 0x29, 0x96, 0xD3,
];
/// `.onepkg` notebooks are Microsoft cabinet files.
pub const CAB_MAGIC: &[u8; 4] = b"MSCF";
const ZIP_MAGIC: &[u8; 4] = b"PK\x03\x04";
const ZIP_EMPTY_MAGIC: &[u8; 4] = b"PK\x05\x06";
const BPLIST_MAGIC: &[u8; 8] = b"bplist00";

/// Why an import failed. `Display` is a sentence fit to show the user.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImportError {
    /// Not a format Mate imports (or not yet); the detail names the extension or format.
    #[error("This file is not a format Mate can import ({0}).")]
    Unsupported(String),
    #[error("This file looks damaged and could not be read ({0}).")]
    Corrupt(String),
    #[error("This file is too large to import ({0}).")]
    Limit(String),
    #[error("This file is password-protected or encrypted. Remove the protection in the app that made it, export it again and retry.")]
    Encrypted,
    #[error("The import was cancelled.")]
    Cancelled,
}

/// Bounds on what parsing a source file may consume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLimits {
    /// Largest source file accepted.
    pub max_file_bytes: u64,
    /// Most pages a parser needs to produce (the placer places at most [`MAX_PAGES_PER_IMPORT`]).
    pub max_pages: usize,
    pub max_zip_entries: usize,
    pub max_unzipped_bytes: u64,
    /// Parsing fails with [`ImportError::Limit`] once this instant has passed.
    pub deadline: Option<Instant>,
}

impl Default for ImportLimits {
    /// The global limits, the largest per-format file cap (OneNote's 256 MiB) and a deadline
    /// [`IMPORT_DEADLINE`] from now.
    fn default() -> Self {
        ImportLimits {
            max_file_bytes: 256 * MIB,
            max_pages: MAX_PAGES_PER_IMPORT,
            max_zip_entries: MAX_ZIP_ENTRIES,
            max_unzipped_bytes: MAX_UNZIPPED_BYTES,
            deadline: Some(Instant::now() + IMPORT_DEADLINE),
        }
    }
}

impl ImportLimits {
    /// [`ImportLimits::default`] with `source`'s file cap: GoodNotes, Notability and Samsung
    /// Notes 100 MiB, OneNote 256 MiB, Freenotes 200 000 000 bytes.
    pub fn for_source(source: ImportSource) -> ImportLimits {
        ImportLimits { max_file_bytes: max_file_bytes(source), ..ImportLimits::default() }
    }
}

/// The per-format file size cap.
pub fn max_file_bytes(source: ImportSource) -> u64 {
    match source {
        ImportSource::GoodNotes | ImportSource::Notability | ImportSource::SamsungNotes => 100 * MIB,
        ImportSource::OneNote => 256 * MIB,
        ImportSource::Freenotes => 200_000_000,
    }
}

/// `Limit` once `limits.deadline` has passed.
pub fn check_deadline(limits: &ImportLimits) -> Result<(), ImportError> {
    match limits.deadline {
        Some(d) if Instant::now() >= d => Err(ImportError::Limit(format!(
            "reading it took longer than {} seconds",
            IMPORT_DEADLINE.as_secs()
        ))),
        _ => Ok(()),
    }
}

/// Lower-case extension of `filename` (without the dot), if any.
fn extension(filename: &str) -> Option<String> {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    base.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
}

fn unsupported(filename: &str) -> ImportError {
    ImportError::Unsupported(match extension(filename) {
        Some(ext) => format!(".{ext}"),
        None => "unknown file type".into(),
    })
}

/// The format a zip-based file's extension suggests.
fn zip_source_from_extension(filename: &str) -> Option<ImportSource> {
    match extension(filename)?.as_str() {
        "goodnotes" => Some(ImportSource::GoodNotes),
        "note" | "nbn" => Some(ImportSource::Notability),
        "freenotes" | "freenotesv2" | "freebackup" => Some(ImportSource::Freenotes),
        "sdocx" => Some(ImportSource::SamsungNotes),
        _ => None,
    }
}

/// Last path component of a zip entry name.
fn base_name(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// Detects the source format from the content; the extension only breaks ties between the zip
/// formats when the entry names are ambiguous (protobuf entries but no GoodNotes index, or no
/// marker at all).
///
/// - OneNote: the `.one` header GUID, or a `MSCF` cabinet (`.onepkg`).
/// - Samsung Notes: a zip with `note.note` and `pageIdInfo.dat`.
/// - GoodNotes: a zip with `index.*.pb` protobuf entries (e.g. `index.attachments.pb`).
/// - Notability: a zip with a `.plist` entry that is a binary (`bplist00`) keyed archive.
/// - Freenotes: a zip with other `.pb` protobuf entries.
pub fn sniff(bytes: &[u8], filename: &str) -> Result<ImportSource, ImportError> {
    if bytes.starts_with(&ONE_MAGIC) || bytes.starts_with(CAB_MAGIC) {
        return Ok(ImportSource::OneNote);
    }
    if !(bytes.starts_with(ZIP_MAGIC) || bytes.starts_with(ZIP_EMPTY_MAGIC)) {
        return Err(unsupported(filename));
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ImportError::Corrupt(format!("zip: {e}")))?;
    if zip.len() > MAX_ZIP_ENTRIES {
        return Err(ImportError::Limit(format!(
            "it contains {} files; the most Mate reads is {MAX_ZIP_ENTRIES}",
            zip.len()
        )));
    }
    let names: Vec<String> = zip
        .file_names()
        .filter(|n| zipsrc::is_safe_name(n))
        .map(str::to_owned)
        .collect();
    let has_base = |b: &str| names.iter().any(|n| base_name(n) == b);
    if has_base("note.note") && has_base("pageIdInfo.dat") {
        return Ok(ImportSource::SamsungNotes);
    }
    let pb_entries: Vec<&str> =
        names.iter().map(|n| base_name(n)).filter(|b| b.ends_with(".pb")).collect();
    if pb_entries.iter().any(|b| b.starts_with("index.")) {
        return Ok(ImportSource::GoodNotes);
    }
    // Notability: a binary plist keyed archive (read only its first 8 bytes).
    for name in names.iter().filter(|n| n.ends_with(".plist")) {
        let Ok(file) = zip.by_name(name) else { continue };
        let mut head = Vec::with_capacity(8);
        if std::io::Read::read_to_end(&mut std::io::Read::take(file, 8), &mut head).is_ok()
            && head.as_slice() == BPLIST_MAGIC
        {
            return Ok(ImportSource::Notability);
        }
    }
    let by_ext = zip_source_from_extension(filename);
    if !pb_entries.is_empty() {
        return Ok(match by_ext {
            Some(ImportSource::GoodNotes) => ImportSource::GoodNotes,
            _ => ImportSource::Freenotes,
        });
    }
    by_ext.ok_or_else(|| unsupported(filename))
}

/// Detects the format and parses the file into an [`ImportDocument`]. The file must fit both
/// `limits.max_file_bytes` and the format's own cap ([`max_file_bytes`]).
pub fn parse(
    bytes: &[u8],
    filename: &str,
    limits: &ImportLimits,
) -> Result<ImportDocument, ImportError> {
    check_deadline(limits)?;
    if bytes.len() as u64 > limits.max_file_bytes {
        return Err(ImportError::Limit(format!(
            "files over {} MiB are not imported",
            limits.max_file_bytes / MIB
        )));
    }
    let source = sniff(bytes, filename)?;
    let cap = limits.max_file_bytes.min(max_file_bytes(source));
    if bytes.len() as u64 > cap {
        return Err(ImportError::Limit(format!(
            "{} files over {} MiB are not imported",
            source.display_name(),
            cap / MIB
        )));
    }
    let zip = || ZipSource::new(bytes, limits);
    match source {
        ImportSource::OneNote => onenote::parse(bytes, filename, limits),
        ImportSource::GoodNotes => goodnotes::parse(&mut zip()?, limits),
        ImportSource::Notability => notability::parse(&mut zip()?, limits),
        ImportSource::Freenotes => freenotes::parse(&mut zip()?, limits),
        ImportSource::SamsungNotes => samsung::parse(&mut zip()?, limits),
    }
}

#[cfg(test)]
mod tests {
    use super::zipsrc::tests::make_zip;
    use super::*;

    #[test]
    fn sniffs_by_content() {
        let mut one = ONE_MAGIC.to_vec();
        one.extend_from_slice(&[0; 32]);
        assert_eq!(sniff(&one, "x.bin"), Ok(ImportSource::OneNote));
        assert_eq!(sniff(b"MSCF\0\0\0\0", "nb.onepkg"), Ok(ImportSource::OneNote));

        let samsung = make_zip(&[("note.note", b"x"), ("pageIdInfo.dat", b"y")]);
        assert_eq!(sniff(&samsung, "a.zip"), Ok(ImportSource::SamsungNotes));
        let gn = make_zip(&[("index.attachments.pb", b""), ("notes/abc", b"")]);
        assert_eq!(sniff(&gn, "a.freenotes"), Ok(ImportSource::GoodNotes));
        let nb = make_zip(&[("Doc/Session.plist", b"bplist00\x01\x02")]);
        assert_eq!(sniff(&nb, "a.zip"), Ok(ImportSource::Notability));
        let fr = make_zip(&[("page1.pb", b"")]);
        assert_eq!(sniff(&fr, "x.zip"), Ok(ImportSource::Freenotes));
        // Extension as tie-break between zip formats.
        assert_eq!(sniff(&fr, "x.goodnotes"), Ok(ImportSource::GoodNotes));
        let bare = make_zip(&[("readme.txt", b"hi")]);
        assert_eq!(sniff(&bare, "x.sdocx"), Ok(ImportSource::SamsungNotes));
        assert_eq!(sniff(&bare, "x.zip"), Err(ImportError::Unsupported(".zip".into())));
    }

    #[test]
    fn extension_alone_is_not_enough() {
        assert_eq!(
            sniff(b"hello world", "notes.goodnotes"),
            Err(ImportError::Unsupported(".goodnotes".into()))
        );
        assert_eq!(
            sniff(b"PK\x03\x04garbage", "notes.goodnotes").map_err(|e| matches!(e, ImportError::Corrupt(_))),
            Err(true)
        );
    }

    #[test]
    fn errors_read_as_sentences() {
        assert_eq!(
            ImportError::Unsupported(".xyz".into()).to_string(),
            "This file is not a format Mate can import (.xyz)."
        );
        for e in [
            ImportError::Corrupt("x".into()),
            ImportError::Limit("x".into()),
            ImportError::Encrypted,
            ImportError::Cancelled,
        ] {
            let s = e.to_string();
            assert!(s.starts_with("Th") && s.ends_with('.'), "{s}");
        }
    }

    #[test]
    fn limits_per_source() {
        assert_eq!(ImportLimits::for_source(ImportSource::Freenotes).max_file_bytes, 200_000_000);
        assert_eq!(ImportLimits::for_source(ImportSource::OneNote).max_file_bytes, 256 * MIB);
        assert_eq!(ImportLimits::for_source(ImportSource::GoodNotes).max_file_bytes, 100 * MIB);
        let d = ImportLimits::default();
        assert_eq!((d.max_pages, d.max_zip_entries, d.max_unzipped_bytes), (2000, 20_000, 1 << 30));
        assert!(d.deadline.is_some());
    }

    #[test]
    fn parse_applies_the_format_cap_and_dispatches() {
        let gn = make_zip(&[("index.attachments.pb", b"")]);
        let tiny = ImportLimits { max_file_bytes: 10, ..ImportLimits::default() };
        assert!(matches!(parse(&gn, "a.goodnotes", &tiny), Err(ImportError::Limit(_))));
        assert!(matches!(
            parse(&gn, "a.goodnotes", &ImportLimits::default()),
            Err(ImportError::Unsupported(_))
        ));
    }
}
