//! Samsung Notes (`.sdocx`): a zip with `note.note` and `pageIdInfo.dat`.
//!
//! Not implemented yet: every file is reported as unsupported.

use super::{ImportDocument, ImportError, ImportLimits, ImportSource, ZipSource, not_yet};

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    let _ = (src, limits);
    Err(not_yet(ImportSource::SamsungNotes))
}
