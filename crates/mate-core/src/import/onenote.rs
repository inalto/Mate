//! OneNote (`.one` sections, `.onepkg` cabinet notebooks): MS-ONESTORE revision stores.
//!
//! Not implemented yet: every file is reported as unsupported.

use super::{ImportDocument, ImportError, ImportLimits, ImportSource, not_yet};

pub fn parse(
    bytes: &[u8],
    filename: &str,
    limits: &ImportLimits,
) -> Result<ImportDocument, ImportError> {
    let _ = (bytes, filename, limits);
    Err(not_yet(ImportSource::OneNote))
}
