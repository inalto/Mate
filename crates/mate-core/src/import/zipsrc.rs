//! Guarded access to zip-based source files (GoodNotes, Notability, Freenotes, Samsung Notes).
//!
//! Opening checks the entry count and the sum of the declared uncompressed sizes against the
//! limits (a zip bomb is rejected before anything is inflated); every read also counts the bytes
//! actually inflated, so an entry that understates its size cannot get past the budget. Entry
//! names with a `..` component, a leading slash/backslash or a drive letter are never served.

use std::io::{Cursor, Read};

use zip::ZipArchive;
use zip::result::ZipError;

use super::{ImportError, ImportLimits, check_deadline};

pub struct ZipSource<'a> {
    zip: ZipArchive<Cursor<&'a [u8]>>,
    limits: ImportLimits,
    /// Bytes inflated so far by [`ZipSource::entry`].
    inflated: u64,
}

fn corrupt(e: ZipError) -> ImportError {
    ImportError::Corrupt(format!("zip: {e}"))
}

fn mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

/// False for names that could escape a directory if ever extracted: `..` components, absolute
/// paths, drive letters, NUL bytes.
pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.starts_with('\\')
        && !name.contains('\0')
        && name.as_bytes().get(1).is_none_or(|b| *b != b':')
        && !name.split(['/', '\\']).any(|part| part == "..")
}

impl<'a> ZipSource<'a> {
    /// Opens `bytes` as a zip: `Corrupt` if it is not one, `Limit` if it has more than
    /// `limits.max_zip_entries` entries or declares more than `limits.max_unzipped_bytes`.
    pub fn new(bytes: &'a [u8], limits: &ImportLimits) -> Result<ZipSource<'a>, ImportError> {
        check_deadline(limits)?;
        let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(corrupt)?;
        if zip.len() > limits.max_zip_entries {
            return Err(ImportError::Limit(format!(
                "it contains {} files; the most Mate reads is {}",
                zip.len(),
                limits.max_zip_entries
            )));
        }
        let mut declared: u64 = 0;
        for i in 0..zip.len() {
            let size = zip.by_index_raw(i).map_err(corrupt)?.size();
            declared = declared.saturating_add(size);
            if declared > limits.max_unzipped_bytes {
                return Err(ImportError::Limit(format!(
                    "it unpacks to more than {} MiB",
                    mib(limits.max_unzipped_bytes)
                )));
            }
        }
        Ok(ZipSource { zip, limits: limits.clone(), inflated: 0 })
    }

    pub fn limits(&self) -> &ImportLimits {
        &self.limits
    }

    /// Every entry name that is safe to serve, in archive order (directories included).
    pub fn names(&self) -> Vec<String> {
        self.zip.file_names().filter(|n| is_safe_name(n)).map(str::to_owned).collect()
    }

    /// True if a safe entry called `name` exists.
    pub fn has(&self, name: &str) -> bool {
        is_safe_name(name) && self.zip.index_for_name(name).is_some()
    }

    /// Names of the safe entries ending with `suffix` (e.g. `".pb"`), sorted.
    pub fn entries_with_suffix(&self, suffix: &str) -> Vec<String> {
        let mut names: Vec<String> =
            self.names().into_iter().filter(|n| n.ends_with(suffix)).collect();
        names.sort();
        names
    }

    /// The inflated content of entry `name`, `None` if absent. `Corrupt` for an unsafe name;
    /// `Limit` once the total inflated bytes would pass `max_unzipped_bytes` or the deadline has
    /// passed.
    pub fn entry(&mut self, name: &str) -> Result<Option<Vec<u8>>, ImportError> {
        check_deadline(&self.limits)?;
        if !is_safe_name(name) {
            return Err(ImportError::Corrupt(format!("unsafe entry name {name:?}")));
        }
        let budget = self.limits.max_unzipped_bytes.saturating_sub(self.inflated);
        let over = || {
            ImportError::Limit(format!(
                "it unpacks to more than {} MiB",
                mib(self.limits.max_unzipped_bytes)
            ))
        };
        let file = match self.zip.by_name(name) {
            Ok(f) => f,
            Err(ZipError::FileNotFound) => return Ok(None),
            Err(e) => return Err(corrupt(e)),
        };
        if file.size() > budget {
            return Err(over());
        }
        let mut data = Vec::with_capacity(usize::try_from(file.size()).unwrap_or(0).min(1 << 26));
        // `take` guards against entries whose declared size understates the real one.
        file.take(budget.saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|e| ImportError::Corrupt(format!("zip entry {name}: {e}")))?;
        if data.len() as u64 > budget {
            return Err(over());
        }
        self.inflated += data.len() as u64;
        Ok(Some(data))
    }

    /// Up to `n` leading bytes of entry `name` (for sniffing), `None` if absent or unsafe.
    pub fn head(&mut self, name: &str, n: usize) -> Result<Option<Vec<u8>>, ImportError> {
        if !is_safe_name(name) {
            return Ok(None);
        }
        let file = match self.zip.by_name(name) {
            Ok(f) => f,
            Err(ZipError::FileNotFound) => return Ok(None),
            Err(e) => return Err(corrupt(e)),
        };
        let mut data = Vec::with_capacity(n);
        file.take(n as u64)
            .read_to_end(&mut data)
            .map_err(|e| ImportError::Corrupt(format!("zip entry {name}: {e}")))?;
        Ok(Some(data))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;

    pub(crate) fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_entries_and_suffixes() {
        let z = make_zip(&[("b.pb", b"bb"), ("a.pb", b"a"), ("x.json", b"{}")]);
        let mut src = ZipSource::new(&z, &ImportLimits::default()).unwrap();
        assert_eq!(src.entries_with_suffix(".pb"), vec!["a.pb", "b.pb"]);
        assert_eq!(src.entry("b.pb").unwrap().as_deref(), Some(&b"bb"[..]));
        assert_eq!(src.entry("missing").unwrap(), None);
        assert!(src.has("x.json"));
        assert_eq!(src.head("x.json", 1).unwrap().as_deref(), Some(&b"{"[..]));
    }

    #[test]
    fn rejects_traversal_names() {
        for bad in ["../evil", "a/../../b", "/abs", "\\abs", "C:\\x", "a\\..\\b"] {
            assert!(!is_safe_name(bad), "{bad}");
        }
        assert!(is_safe_name("dir/file..pb"));
        let z = make_zip(&[("../evil", b"x"), ("ok", b"y")]);
        let mut src = ZipSource::new(&z, &ImportLimits::default()).unwrap();
        assert_eq!(src.names(), vec!["ok"]);
        assert!(!src.has("../evil"));
        assert!(matches!(src.entry("../evil"), Err(ImportError::Corrupt(_))));
    }

    #[test]
    fn enforces_entry_count_and_inflated_budget() {
        let z = make_zip(&[("a", b"0123456789"), ("b", b"0123456789"), ("c", b"x")]);
        let limits = ImportLimits { max_zip_entries: 2, ..ImportLimits::default() };
        assert!(matches!(ZipSource::new(&z, &limits), Err(ImportError::Limit(_))));

        // Declared total (21) over the budget: rejected on open.
        let limits = ImportLimits { max_unzipped_bytes: 20, ..ImportLimits::default() };
        assert!(matches!(ZipSource::new(&z, &limits), Err(ImportError::Limit(_))));

        // Reads accumulate: the third read of the same 10-byte entry passes a 25-byte budget.
        let limits = ImportLimits { max_unzipped_bytes: 25, ..ImportLimits::default() };
        let mut src = ZipSource::new(&z, &limits).unwrap();
        src.entry("a").unwrap();
        src.entry("b").unwrap();
        assert!(matches!(src.entry("a"), Err(ImportError::Limit(_))));
    }

    #[test]
    fn not_a_zip_is_corrupt() {
        assert!(matches!(
            ZipSource::new(b"definitely not a zip", &ImportLimits::default()),
            Err(ImportError::Corrupt(_))
        ));
    }

    #[test]
    fn honours_the_deadline() {
        let z = make_zip(&[("a", b"1")]);
        let limits = ImportLimits {
            deadline: Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
            ..ImportLimits::default()
        };
        assert!(matches!(ZipSource::new(&z, &limits), Err(ImportError::Limit(_))));
    }
}
