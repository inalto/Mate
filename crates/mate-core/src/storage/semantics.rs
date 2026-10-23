//! Page semantics: cached summary/title, the page's recognised text, and the documents the
//! local similarity model runs over.

use rusqlite::{OptionalExtension, params};

use super::{Result, Storage, json_col};
use crate::model::now_iso;
use crate::semantics::PageSemantics;
use crate::semantics::related::{self, PageDoc, PageGraph, RelatedPage};

impl Storage {
    pub fn get_page_semantics(&self, page_id: &str) -> Result<Option<PageSemantics>> {
        Ok(self
            .conn
            .query_row(
                "SELECT page_id, summary, suggested_title, topics, content_hash, updated_at \
                 FROM page_semantics WHERE page_id = ?1",
                [page_id],
                |r| {
                    Ok(PageSemantics {
                        page_id: r.get(0)?,
                        summary: r.get(1)?,
                        suggested_title: r.get(2)?,
                        topics: json_col(r, 3)?,
                        content_hash: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Inserts or replaces the page's cached semantics (`updated_at` is stamped now).
    pub fn upsert_page_semantics(&mut self, s: &PageSemantics) -> Result<()> {
        self.conn.execute(
            "INSERT INTO page_semantics (page_id, summary, suggested_title, topics, content_hash, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(page_id) DO UPDATE SET summary = excluded.summary, \
                suggested_title = excluded.suggested_title, topics = excluded.topics, \
                content_hash = excluded.content_hash, updated_at = excluded.updated_at",
            params![
                s.page_id,
                s.summary,
                s.suggested_title,
                serde_json::to_string(&s.topics)?,
                s.content_hash,
                now_iso()
            ],
        )?;
        Ok(())
    }

    /// The page's recognised text (LaTeX when there is some, else the transcription, else the
    /// description) in reading order: top to bottom by bounds `y`, then left to right by `x`.
    pub fn page_recognised_text(&self, page_id: &str) -> Result<String> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT latex, description, transcription, \
                    COALESCE(json_extract(bounds, '$.y'), 0) AS y, \
                    COALESCE(json_extract(bounds, '$.x'), 0) AS x \
             FROM stroke_group_recognition WHERE page_id = ?1 ORDER BY y, x, stroke_group_id",
        )?;
        let rows = stmt.query_map([page_id], |r| {
            let latex: String = r.get(0)?;
            let description: String = r.get(1)?;
            let transcription: Option<String> = r.get(2)?;
            Ok((latex, description, transcription))
        })?;
        let mut lines = Vec::new();
        for row in rows {
            let (latex, description, transcription) = row?;
            let transcribed = transcription
                .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                .and_then(|v| v["text"].as_str().map(str::to_string))
                .unwrap_or_default();
            let line = [latex, transcribed, description].into_iter().find(|s| !s.trim().is_empty());
            if let Some(line) = line {
                lines.push(line.trim().to_string());
            }
        }
        Ok(lines.join("\n"))
    }

    /// Every live page with recognised search text, for the similarity model. The text is the
    /// page's `recognition_fts` content (one entry per stroke group) joined by newlines.
    pub fn page_documents(&self) -> Result<Vec<PageDoc>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT f.page_id, p.title, group_concat(f.content, char(10)) \
             FROM recognition_fts f JOIN pages p ON p.id = f.page_id \
             WHERE p.deleted_at IS NULL GROUP BY f.page_id ORDER BY f.page_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PageDoc {
                page_id: r.get(0)?,
                title: r.get(1)?,
                text: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Pages whose recognised text resembles this page's (cosine over TF-IDF, at least 0.2).
    pub fn related_pages(&self, page_id: &str, limit: usize) -> Result<Vec<RelatedPage>> {
        Ok(related::related_pages(&self.page_documents()?, page_id, limit))
    }

    /// Similarity graph over all live pages with recognised text.
    pub fn page_graph(&self, min_score: f64) -> Result<PageGraph> {
        Ok(related::page_graph(&self.page_documents()?, min_score))
    }
}
