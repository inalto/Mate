//! Freenotes (`.freenotes`, `.freenotesv2`, `.freebackup`): a zip of protobuf records.
//!
//! Not implemented yet: every file is reported as unsupported.

use super::{ImportDocument, ImportError, ImportLimits, ImportSource, ZipSource, not_yet};

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    let _ = (src, limits);
    Err(not_yet(ImportSource::Freenotes))
}
