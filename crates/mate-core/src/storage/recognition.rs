//! Tutor recognitions per stroke group, their full-text search rows, invalidation when ink
//! changes, and learning events.
//!
//! Invariants kept here (all writes are transactional):
//! - every `stroke_group_recognition` row has exactly one `recognition_fts` row (`fts_rowid`);
//!   deleting a recognition row by any path drops its search row (trigger in `schema_v2.sql`);
//! - `recognition_elements` mirrors each row's `element_ids`, so the groups touched by an element
//!   edit are found by index, not by scanning JSON;
//! - an element belongs to at most one recognised group per page: upserting a group supersedes
//!   older groups that shared any of its elements.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use super::{Result, Storage, StorageError, enum_col, enum_to_sql, json_col, opt_enum_col, opt_json_col};
use crate::ai::verdict::Verdict;
use crate::model::{format_iso, now_iso};

/// Axis-aligned bounds of a stroke group, in page (world) units.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Whether the recognition came from the automatic settle (`auto`) or a user request (`user`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecognitionSource {
    #[default]
    Auto,
    User,
}

/// What [`Storage::upsert_recognition`] did with a result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpsertOutcome {
    Stored,
    /// The ink changed after capture, or a newer capture of overlapping ink is already stored:
    /// nothing was written. Callers drop the result quietly.
    Stale,
}

/// A persisted verdict for one stroke group. On the wire the verdict's fields are flattened
/// next to the group's (camelCase), e.g. `{pageId, strokeGroupId, elementIds, bounds, latex, …}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recognition {
    pub page_id: String,
    pub stroke_group_id: String,
    pub element_ids: Vec<String>,
    pub bounds: Bounds,
    /// `code` and `kind` are always re-derived by the store; incoming values are ignored.
    #[serde(flatten)]
    pub verdict: Verdict,
    /// When the frontend captured the group's ink, in ms since the Unix epoch. Required (> 0):
    /// it is how the store recognises stale and out-of-order results.
    pub captured_at: i64,
    #[serde(default)]
    pub source: RecognitionSource,
    /// The user set `correct` by hand ("Mark as correct"); `verdict.correct` holds their call.
    #[serde(default)]
    pub user_override: bool,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    /// Stamped by the store on first insert when empty; kept on later upserts.
    #[serde(default)]
    pub created_at: String,
    /// Always stamped by the store.
    #[serde(default)]
    pub updated_at: String,
}

/// Tutor telemetry: `kind` is e.g. `attempt`, `hint_shown`, `why_shown`, `next_shown`,
/// `override`, `ask`, `erase`, `edit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningEvent {
    /// Generated when empty.
    #[serde(default)]
    pub id: String,
    pub page_id: String,
    #[serde(default)]
    pub stroke_group_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    /// Stamped now when empty.
    #[serde(default)]
    pub created_at: String,
}

const REC_COLS: &str = "page_id, stroke_group_id, element_ids, kind, latex, description, correct, \
     code, domain, error_nature, hint, explanation, next_steps, focus_span, illegible, \
     transcription, bounds, source, user_override, provider, model, created_at, updated_at, \
     captured_at";

fn recognition_from_row(r: &Row) -> rusqlite::Result<Recognition> {
    let mut verdict = Verdict {
        latex: r.get(4)?,
        description: r.get(5)?,
        correct: r.get(6)?,
        domain: enum_col(r, 8)?,
        error_nature: opt_enum_col(r, 9)?,
        hint: r.get(10)?,
        explanation: r.get(11)?,
        next_steps: r.get(12)?,
        focus_span: r.get(13)?,
        illegible: r.get(14)?,
        transcription: opt_json_col(r, 15)?,
        ..Verdict::default()
    };
    // `code`/`kind` columns are for SQL consumers; the struct re-derives them from the fields.
    verdict.validate();
    Ok(Recognition {
        page_id: r.get(0)?,
        stroke_group_id: r.get(1)?,
        element_ids: json_col(r, 2)?,
        bounds: json_col(r, 16)?,
        verdict,
        source: enum_col(r, 17)?,
        user_override: r.get(18)?,
        provider: r.get(19)?,
        model: r.get(20)?,
        created_at: r.get(21)?,
        updated_at: r.get(22)?,
        captured_at: r.get(23)?,
    })
}

/// The text indexed for search: latex, description and transcription. ASCII control characters
/// become spaces, so provider text cannot forge the snippet markers.
fn fts_content(v: &Verdict) -> String {
    let transcription = v.transcription.as_ref().map(|t| t.text.as_str()).unwrap_or("");
    format!("{} {} {}", v.latex, v.description, transcription)
        .chars()
        .map(|c| if c.is_ascii_control() { ' ' } else { c })
        .collect()
}

fn same_set(a: &[String], b: &[String]) -> bool {
    let a: BTreeSet<&String> = a.iter().collect();
    let b: BTreeSet<&String> = b.iter().collect();
    a == b
}

/// The capture instant in the stored `ink_updated_at` format (ISO, ms, UTC).
fn capture_iso(captured_at_ms: i64) -> Result<String> {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(captured_at_ms) * 1_000_000)
        .map_err(|e| StorageError::Limit(format!("capturedAt out of range: {e}")))?;
    Ok(format_iso(at))
}

/// True when `rec` no longer describes the ink: a member element is missing, erased, on another
/// page or had its ink changed after the capture; or a stored recognition of overlapping ink
/// (same group or sharing an element) was captured later.
fn is_stale(conn: &Connection, rec: &Recognition) -> Result<bool> {
    let captured = capture_iso(rec.captured_at)?;
    let mut member = conn.prepare_cached(
        "SELECT page_id, deleted_at IS NOT NULL, ink_updated_at FROM elements WHERE id = ?1",
    )?;
    for id in &rec.element_ids {
        let row = member
            .query_row([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<String>>(2)?))
            })
            .optional()?;
        match row {
            None => return Ok(true),
            Some((page, deleted, ink_at)) => {
                if deleted || page != rec.page_id || ink_at.is_some_and(|t| t > captured) {
                    return Ok(true);
                }
            }
        }
    }
    let newer: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM stroke_group_recognition          WHERE page_id = ?1 AND stroke_group_id = ?2 AND captured_at > ?3)",
        params![rec.page_id, rec.stroke_group_id, rec.captured_at],
        |r| r.get(0),
    )?;
    if newer {
        return Ok(true);
    }
    let mut overlapping = conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM recognition_elements m            JOIN stroke_group_recognition g              ON g.page_id = m.page_id AND g.stroke_group_id = m.stroke_group_id          WHERE m.page_id = ?1 AND m.element_id = ?2 AND g.captured_at > ?3)",
    )?;
    for id in &rec.element_ids {
        if overlapping.query_row(params![rec.page_id, id, rec.captured_at], |r| r.get::<_, bool>(0))? {
            return Ok(true);
        }
    }
    Ok(false)
}

struct Existing {
    element_ids: Vec<String>,
    user_override: bool,
    correct: Option<bool>,
    created_at: String,
    fts_rowid: Option<i64>,
}

fn existing(conn: &Connection, page_id: &str, group_id: &str) -> Result<Option<Existing>> {
    Ok(conn
        .query_row(
            "SELECT element_ids, user_override, correct, created_at, fts_rowid \
             FROM stroke_group_recognition WHERE page_id = ?1 AND stroke_group_id = ?2",
            params![page_id, group_id],
            |r| {
                Ok(Existing {
                    element_ids: json_col(r, 0)?,
                    user_override: r.get(1)?,
                    correct: r.get(2)?,
                    created_at: r.get(3)?,
                    fts_rowid: r.get(4)?,
                })
            },
        )
        .optional()?)
}

/// How far ahead of this clock a capture stamp may be.
const MAX_CAPTURE_SKEW_MS: i64 = 60_000;

fn upsert_in(conn: &Connection, rec: &Recognition) -> Result<UpsertOutcome> {
    if rec.page_id.is_empty() || rec.stroke_group_id.is_empty() || rec.element_ids.is_empty() {
        return Err(StorageError::Limit(
            "recognition needs a page id, a stroke group id and at least one element".into(),
        ));
    }
    if rec.captured_at <= 0 {
        return Err(StorageError::Limit("recognition needs capturedAt (ms since the epoch)".into()));
    }
    // A capture stamp from a skewed clock far ahead would make every later result for this ink
    // look older, so it would be reported stale forever: refuse it instead.
    let now_ms = i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX);
    if rec.captured_at > now_ms.saturating_add(MAX_CAPTURE_SKEW_MS) {
        return Err(StorageError::Limit("recognition capturedAt is in the future".into()));
    }
    if is_stale(conn, rec)? {
        return Ok(UpsertOutcome::Stale);
    }
    let prev = existing(conn, &rec.page_id, &rec.stroke_group_id)?;
    let mut verdict = rec.verdict.clone();
    let mut user_override = rec.user_override;
    // A re-recognition of the same ink keeps the user's own call.
    if let Some(p) = prev.as_ref().filter(|p| p.user_override && !user_override)
        && same_set(&p.element_ids, &rec.element_ids)
    {
        user_override = true;
        verdict.correct = p.correct;
    }
    verdict.validate();

    // Supersede older groups on this page that share an element with this one.
    {
        let mut supersede = conn.prepare_cached(
            "DELETE FROM stroke_group_recognition WHERE page_id = ?1 AND stroke_group_id <> ?2 \
             AND stroke_group_id IN (SELECT stroke_group_id FROM recognition_elements \
                                     WHERE element_id = ?3 AND page_id = ?1)",
        )?;
        for id in &rec.element_ids {
            supersede.execute(params![rec.page_id, rec.stroke_group_id, id])?;
        }
    }

    // Rewrite the search row.
    if let Some(rowid) = prev.as_ref().and_then(|p| p.fts_rowid) {
        conn.execute("DELETE FROM recognition_fts WHERE rowid = ?1", [rowid])?;
    }
    conn.execute(
        "INSERT INTO recognition_fts (page_id, stroke_group_id, content) VALUES (?1, ?2, ?3)",
        params![rec.page_id, rec.stroke_group_id, fts_content(&verdict)],
    )?;
    let fts_rowid = conn.last_insert_rowid();

    let now = now_iso();
    let created_at = match &prev {
        Some(p) => p.created_at.clone(),
        None if !rec.created_at.is_empty() => rec.created_at.clone(),
        None => now.clone(),
    };
    conn.execute(
        &format!(
            "INSERT INTO stroke_group_recognition ({REC_COLS}, fts_rowid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
             ON CONFLICT(page_id, stroke_group_id) DO UPDATE SET
               element_ids = excluded.element_ids, kind = excluded.kind, latex = excluded.latex,
               description = excluded.description, correct = excluded.correct,
               code = excluded.code, domain = excluded.domain,
               error_nature = excluded.error_nature, hint = excluded.hint,
               explanation = excluded.explanation, next_steps = excluded.next_steps,
               focus_span = excluded.focus_span, illegible = excluded.illegible,
               transcription = excluded.transcription, bounds = excluded.bounds,
               source = excluded.source, user_override = excluded.user_override,
               provider = excluded.provider, model = excluded.model,
               updated_at = excluded.updated_at, captured_at = excluded.captured_at,
               fts_rowid = excluded.fts_rowid"
        ),
        params![
            rec.page_id,
            rec.stroke_group_id,
            serde_json::to_string(&rec.element_ids)?,
            enum_to_sql(&verdict.kind)?,
            verdict.latex,
            verdict.description,
            verdict.correct,
            enum_to_sql(&verdict.code)?,
            enum_to_sql(&verdict.domain)?,
            verdict.error_nature.as_ref().map(enum_to_sql).transpose()?,
            verdict.hint,
            verdict.explanation,
            verdict.next_steps,
            verdict.focus_span,
            verdict.illegible,
            verdict.transcription.as_ref().map(serde_json::to_string).transpose()?,
            serde_json::to_string(&rec.bounds)?,
            enum_to_sql(&rec.source)?,
            user_override,
            rec.provider,
            rec.model,
            created_at,
            now,
            rec.captured_at,
            fts_rowid,
        ],
    )?;

    conn.execute(
        "DELETE FROM recognition_elements WHERE page_id = ?1 AND stroke_group_id = ?2",
        params![rec.page_id, rec.stroke_group_id],
    )?;
    let mut member = conn.prepare_cached(
        "INSERT OR IGNORE INTO recognition_elements (page_id, stroke_group_id, element_id) \
         VALUES (?1, ?2, ?3)",
    )?;
    for id in &rec.element_ids {
        member.execute(params![rec.page_id, rec.stroke_group_id, id])?;
    }
    Ok(UpsertOutcome::Stored)
}

/// Deletes every recognition whose group contains any of `element_ids` (search rows go via the
/// delete trigger, membership rows via the cascade). Returns the number of groups removed.
/// Uses the indexed `recognition_elements` table: cost is per touched element, not per row.
pub(crate) fn invalidate_in(conn: &Connection, element_ids: &[String]) -> Result<usize> {
    if element_ids.is_empty() {
        return Ok(0);
    }
    let mut groups = BTreeSet::new();
    {
        let mut find = conn.prepare_cached(
            "SELECT page_id, stroke_group_id FROM recognition_elements WHERE element_id = ?1",
        )?;
        for id in element_ids {
            let rows = find.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                groups.insert(row?);
            }
        }
    }
    let mut delete = conn.prepare_cached(
        "DELETE FROM stroke_group_recognition WHERE page_id = ?1 AND stroke_group_id = ?2",
    )?;
    let mut removed = 0;
    for (page_id, group_id) in &groups {
        removed += delete.execute(params![page_id, group_id])?;
    }
    Ok(removed)
}

impl Storage {
    /// Inserts or replaces the recognition for `(page_id, stroke_group_id)` and its search row,
    /// unless the result is stale.
    ///
    /// Contract: `rec.captured_at` is when the frontend captured the group's ink (ms epoch).
    /// Inside one transaction the result is rejected with `Ok(UpsertOutcome::Stale)` (nothing
    /// written) when any member element is missing, soft-deleted, on another page, or had its
    /// ink changed (`elements.ink_updated_at`) after `captured_at`; or when a stored recognition
    /// of the same group or of any overlapping group has a later `captured_at`. Element writes
    /// must therefore reach the store before results for that ink (the write-behind queue
    /// flushes in 150 ms, well inside the 1200 ms settle); a result for ink not yet flushed is
    /// reported stale and is re-requested by the next settle.
    ///
    /// When stored: `code`/`kind` are re-derived; `created_at` is kept from the first insert; a
    /// user override survives a re-recognition of the same element set; older groups sharing an
    /// element are superseded. Errors only on invalid input (empty ids, `captured_at <= 0` or
    /// more than 60 s in the future) or a database failure.
    pub fn upsert_recognition(&mut self, rec: &Recognition) -> Result<UpsertOutcome> {
        let tx = self.conn.transaction()?;
        let outcome = upsert_in(&tx, rec)?;
        tx.commit()?;
        Ok(outcome)
    }

    /// Recognitions of a page, oldest first.
    pub fn get_recognitions(&self, page_id: &str) -> Result<Vec<Recognition>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {REC_COLS} FROM stroke_group_recognition WHERE page_id = ?1 \
             ORDER BY created_at, stroke_group_id"
        ))?;
        let rows = stmt.query_map([page_id], recognition_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Records the user's own verdict on a group ("Mark as correct"): sets `correct`, re-derives
    /// `code` and clears `error_nature` when correct. `NotFound` if the group has no verdict.
    pub fn set_user_override(&mut self, page_id: &str, group_id: &str, correct: bool) -> Result<()> {
        let tx = self.conn.transaction()?;
        let mut rec = tx
            .query_row(
                &format!(
                    "SELECT {REC_COLS} FROM stroke_group_recognition \
                     WHERE page_id = ?1 AND stroke_group_id = ?2"
                ),
                params![page_id, group_id],
                recognition_from_row,
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("recognition {page_id}/{group_id}")))?;
        rec.verdict.correct = Some(correct);
        rec.verdict.validate();
        tx.execute(
            "UPDATE stroke_group_recognition SET correct = ?3, code = ?4, error_nature = ?5, \
             user_override = 1, updated_at = ?6 WHERE page_id = ?1 AND stroke_group_id = ?2",
            params![
                page_id,
                group_id,
                rec.verdict.correct,
                enum_to_sql(&rec.verdict.code)?,
                rec.verdict.error_nature.as_ref().map(enum_to_sql).transpose()?,
                now_iso(),
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Drops the verdicts (and search rows) of every group containing any of `element_ids`.
    /// Returns how many groups were removed. `upsert_elements`/`delete_elements` call this in
    /// their own transaction; this entry point is for callers outside an element write.
    pub fn invalidate_recognition_for_elements(&mut self, element_ids: &[String]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let n = invalidate_in(&tx, element_ids)?;
        tx.commit()?;
        Ok(n)
    }

    /// Appends a learning event; fills `id` and `created_at` when empty.
    pub fn record_learning_event(&mut self, ev: &LearningEvent) -> Result<()> {
        if ev.kind.trim().is_empty() {
            return Err(StorageError::Limit("learning event needs a kind".into()));
        }
        let id = if ev.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { ev.id.clone() };
        let created_at = if ev.created_at.is_empty() { now_iso() } else { ev.created_at.clone() };
        let payload = if ev.payload.is_null() { "{}".to_string() } else { serde_json::to_string(&ev.payload)? };
        self.conn.execute(
            "INSERT INTO learning_events (id, page_id, stroke_group_id, kind, payload, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, ev.page_id, ev.stroke_group_id, ev.kind, payload, created_at],
        )?;
        Ok(())
    }

    /// Learning events of a page, oldest first.
    pub fn learning_events(&self, page_id: &str) -> Result<Vec<LearningEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, page_id, stroke_group_id, kind, payload, created_at FROM learning_events \
             WHERE page_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map([page_id], |r| {
            Ok(LearningEvent {
                id: r.get(0)?,
                page_id: r.get(1)?,
                stroke_group_id: r.get(2)?,
                kind: r.get(3)?,
                payload: json_col(r, 4)?,
                created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fts_rows(st: &Storage) -> i64 {
        st.conn.query_row("SELECT COUNT(*) FROM recognition_fts", [], |r| r.get(0)).unwrap()
    }

    fn rec(group: &str, ids: &[&str]) -> Recognition {
        Recognition {
            page_id: "p1".into(),
            stroke_group_id: group.into(),
            element_ids: ids.iter().map(|s| s.to_string()).collect(),
            bounds: Bounds::default(),
            verdict: Verdict { latex: "x".into(), ..Verdict::default() },
            captured_at: i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap(),
            source: RecognitionSource::Auto,
            user_override: false,
            provider: String::new(),
            model: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn page_storage() -> Storage {
        let st = Storage::open_in_memory().unwrap();
        st.conn
            .execute_batch(
                "INSERT INTO units (id, title, created_at, updated_at) VALUES ('u', 'U', 'a', 'a');
                 INSERT INTO sections (id, unit_id, title, color, created_at, updated_at)
                   VALUES ('s', 'u', 'S', '#000', 'a', 'a');
                 INSERT INTO pages (id, section_id, title, mode, background_config, created_at, updated_at)
                   VALUES ('p1', 's', 'P', 'canvas', '{}', 'a', 'a');
                 INSERT INTO elements (id, page_id, type, points, color, width, created_at,
                                       updated_at, ink_updated_at)
                   SELECT column1, 'p1', 'stroke', '[]', '#000', 1, 'a', 'a', '2020-01-01T00:00:00.000Z'
                   FROM (VALUES ('a'), ('b'), ('c'), ('d'));",
            )
            .unwrap();
        st
    }

    #[test]
    fn search_rows_track_recognition_rows() {
        let mut st = page_storage();
        st.upsert_recognition(&rec("g1", &["a", "b"])).unwrap();
        st.upsert_recognition(&rec("g1", &["a", "b"])).unwrap();
        st.upsert_recognition(&rec("g2", &["c"])).unwrap();
        assert_eq!(fts_rows(&st), 2);
        // Supersession drops g1 and its search row.
        st.upsert_recognition(&rec("g3", &["b", "d"])).unwrap();
        assert_eq!(fts_rows(&st), 2);
        assert_eq!(st.invalidate_recognition_for_elements(&["c".into()]).unwrap(), 1);
        assert_eq!(fts_rows(&st), 1);
        // A page purge cascades to recognitions and the trigger clears search rows.
        st.conn.execute("DELETE FROM pages WHERE id = 'p1'", []).unwrap();
        assert_eq!(fts_rows(&st), 0);
        let members: i64 =
            st.conn.query_row("SELECT COUNT(*) FROM recognition_elements", [], |r| r.get(0)).unwrap();
        assert_eq!(members, 0);
    }

    #[test]
    fn fts_content_strips_control_characters() {
        let v = Verdict { latex: "a\u{2}b\u{3}".into(), description: "x\ny".into(), ..Verdict::default() };
        assert_eq!(fts_content(&v), "a b  x y ");
    }

    #[test]
    fn fts5_is_compiled_in() {
        let st = Storage::open_in_memory().unwrap();
        let on: i64 = st
            .conn
            .query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(on, 1);
    }
}
