//! Full-text search over recognised handwriting (`recognition_fts`, FTS5 + bm25).

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Result, Storage};

/// Marks the start of a matched term inside [`SearchHit::snippet`]. Control characters rather
/// than HTML, so the snippet is plain text and the UI decides how to highlight it.
pub const SNIPPET_OPEN: &str = "\u{2}";
/// Marks the end of a matched term inside [`SearchHit::snippet`].
pub const SNIPPET_CLOSE: &str = "\u{3}";

/// Results are capped at this many whatever the caller asks.
const MAX_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page_id: String,
    pub stroke_group_id: String,
    /// Plain-text excerpt; matched terms are wrapped in [`SNIPPET_OPEN`]/[`SNIPPET_CLOSE`].
    pub snippet: String,
    /// FTS5 `bm25` score: lower is a better match. Hits are returned best first.
    pub rank: f64,
}

/// Turns free user input into a safe FTS5 query: each whitespace-separated token becomes a
/// quoted string (so `AND`, `NEAR(`, `*`, `"`, `col:` are literal text), tokens are ANDed, and
/// the last one is a prefix match for search-as-you-type. Tokens with no letter or digit are
/// dropped (they would tokenize to nothing). `None` when nothing searchable is left.
pub(crate) fn fts_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    let mut query = tokens.join(" ");
    if query.is_empty() {
        return None;
    }
    query.push('*');
    Some(query)
}

impl Storage {
    /// Best-first full-text matches over recognised latex, descriptions and transcriptions on
    /// live (not trashed) pages. Never fails on odd user input: unsearchable input gives `[]`.
    pub fn search_recognition(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let Some(q) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let limit = limit.clamp(1, MAX_LIMIT) as i64;
        let mut stmt = self.conn.prepare_cached(
            "SELECT f.page_id, f.stroke_group_id, \
                    snippet(recognition_fts, 2, ?2, ?3, '…', 12), bm25(recognition_fts) AS score \
             FROM recognition_fts f JOIN pages p ON p.id = f.page_id \
             WHERE recognition_fts MATCH ?1 AND p.deleted_at IS NULL \
             ORDER BY score LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![q, SNIPPET_OPEN, SNIPPET_CLOSE, limit], |r| {
            Ok(SearchHit {
                page_id: r.get(0)?,
                stroke_group_id: r.get(1)?,
                snippet: r.get(2)?,
                rank: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::fts_query;

    #[test]
    fn quotes_every_token_and_prefixes_the_last() {
        assert_eq!(fts_query("x^2 AND"), Some("\"x^2\" \"AND\"*".into()));
        assert_eq!(fts_query("say \"hi\""), Some("\"say\" \"\"\"hi\"\"\"*".into()));
        assert_eq!(fts_query("  * ( ) "), None);
        assert_eq!(fts_query(""), None);
    }
}
