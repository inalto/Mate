//! Local page semantics: TF-IDF similarity (related pages, graph) and cached LLM summaries.

pub mod related;
pub mod summary;
pub mod tfidf;

use serde::{Deserialize, Serialize};

/// Cached per-page results. `summary` and `suggested_title` are valid only while
/// `content_hash` equals the hash of the page's current recognised text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSemantics {
    pub page_id: String,
    pub summary: Option<String>,
    pub suggested_title: Option<String>,
    pub topics: Vec<String>,
    pub content_hash: Option<String>,
    pub updated_at: String,
}

/// FNV-1a 64-bit hash of the text, as hex. Stable across Rust versions, unlike `DefaultHasher`.
pub fn content_hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}
