//! FNV-1a-64 fingerprints identifying imported files, pages and elements.

use super::ImportSource;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
/// Separates the hashed fields so `("ab", "c")` and `("a", "bc")` differ.
const SEP: &[u8] = &[0x1f];

fn update(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// FNV-1a 64-bit hash of `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    update(FNV_OFFSET, bytes)
}

/// 16 lowercase hex digits of the file's hash: the `file_fingerprint` passed to the placer.
pub fn file_fingerprint(bytes: &[u8]) -> String {
    format!("{:016x}", fnv1a64(bytes))
}

/// `content.importFingerprint` of an imported element: 16 hex digits of FNV-1a-64 over
/// (source, source page id, element index on that page).
pub fn element_fingerprint(source: ImportSource, source_page_id: &str, index: usize) -> String {
    let mut h = update(FNV_OFFSET, source.as_str().as_bytes());
    h = update(h, SEP);
    h = update(h, source_page_id.as_bytes());
    h = update(h, SEP);
    h = update(h, index.to_string().as_bytes());
    format!("{h:016x}")
}

/// `import_metadata.sourceFingerprint` of an imported page: 16 hex digits of FNV-1a-64 over
/// (file hash, source page id).
pub fn page_fingerprint(file_fp: u64, source_page_id: &str) -> String {
    let mut h = update(FNV_OFFSET, &file_fp.to_le_bytes());
    h = update(h, SEP);
    h = update(h, source_page_id.as_bytes());
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_known_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn fingerprints_are_16_hex_and_distinct() {
        let a = element_fingerprint(ImportSource::GoodNotes, "p1", 0);
        let b = element_fingerprint(ImportSource::GoodNotes, "p1", 1);
        let c = element_fingerprint(ImportSource::Notability, "p1", 0);
        for f in [&a, &b, &c] {
            assert_eq!(f.len(), 16);
            assert!(f.chars().all(|ch| ch.is_ascii_hexdigit()));
        }
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(page_fingerprint(7, "x"), page_fingerprint(7, "x"));
        assert_ne!(page_fingerprint(7, "x"), page_fingerprint(8, "x"));
        assert_eq!(file_fingerprint(b"a"), "af63dc4c8601ec8c");
    }
}
