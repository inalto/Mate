//! Recall answers (the cover study run) and the statistics read back from them.
//!
//! An answer is a `learning_events` row of kind `recall` with payload `{elementId, knew, runId}`.
//! Rows are never removed with their cover: the history outlives the element. Payloads are parsed
//! here, and a row whose payload does not parse is skipped, never an error.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use super::{LearningEvent, Result, Storage, StorageError, json_col};
use crate::model::format_iso;

pub const RECALL_KIND: &str = "recall";

/// How many of the latest runs the trend shows.
const TREND_RUNS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallAnswer {
    pub page_id: String,
    pub element_id: String,
    pub knew: bool,
    pub run_id: String,
}

/// One run: the answers sharing a `runId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallRun {
    pub run_id: String,
    /// When the run's last answer was given.
    pub at: String,
    pub known: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallPageStats {
    pub page_id: String,
    /// Live covers on the page.
    pub covers: u32,
    pub answers: u32,
    pub known: u32,
    pub runs: u32,
    pub last: Option<RecallRun>,
    /// Known rate of the last 8 runs, oldest first.
    pub trend: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallRate {
    pub answers: u32,
    pub known: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallUnitStats {
    pub pages: Vec<RecallPageStats>,
    pub covers: u32,
    pub all: RecallRate,
    pub last7: RecallRate,
    pub last30: RecallRate,
}

/// A parsed recall row.
struct Answer {
    element_id: String,
    knew: bool,
    run_id: String,
    at: String,
}

fn parse_answer(payload: &serde_json::Value, at: String) -> Option<Answer> {
    Some(Answer {
        element_id: payload.get("elementId")?.as_str()?.to_string(),
        knew: payload.get("knew")?.as_bool()?,
        run_id: payload.get("runId")?.as_str()?.to_string(),
        at,
    })
}

/// The page's recall answers, oldest first (ties keep insertion order).
fn page_answers(conn: &Connection, page_id: &str) -> Result<Vec<Answer>> {
    let mut stmt = conn.prepare_cached(
        "SELECT payload, created_at FROM learning_events WHERE page_id = ?1 AND kind = ?2 \
         ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(params![page_id, RECALL_KIND], |r| {
        Ok((json_col::<serde_json::Value>(r, 0), r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (payload, at) = row?;
        if let Some(a) = payload.ok().and_then(|p| parse_answer(&p, at)) {
            out.push(a);
        }
    }
    Ok(out)
}

fn count_covers(conn: &Connection, page_id: &str) -> Result<u32> {
    let mut stmt = conn.prepare_cached(
        "SELECT type, pen_style, content FROM elements \
         WHERE page_id = ?1 AND deleted_at IS NULL AND type IN ('stroke', 'shape')",
    )?;
    let rows = stmt.query_map([page_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))
    })?;
    let mut n = 0;
    for row in rows {
        let (kind, pen, content) = row?;
        let is_cover = match kind.as_str() {
            "stroke" => pen.as_deref() == Some("cover"),
            _ => content
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                .and_then(|c| c.get("cover").and_then(serde_json::Value::as_bool))
                == Some(true),
        };
        if is_cover {
            n += 1;
        }
    }
    Ok(n)
}

fn page_stats(conn: &Connection, page_id: &str, answers: &[Answer]) -> Result<RecallPageStats> {
    // Runs in the order of their last answer; `answers` is already oldest first.
    let mut runs: Vec<RecallRun> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for a in answers {
        let i = *index.entry(a.run_id.as_str()).or_insert_with(|| {
            runs.push(RecallRun { run_id: a.run_id.clone(), at: a.at.clone(), known: 0, total: 0 });
            runs.len() - 1
        });
        runs[i].total += 1;
        runs[i].known += u32::from(a.knew);
        runs[i].at.clone_from(&a.at);
    }
    runs.sort_by(|a, b| a.at.cmp(&b.at));
    let trend = runs
        .iter()
        .skip(runs.len().saturating_sub(TREND_RUNS))
        .map(|r| f64::from(r.known) / f64::from(r.total))
        .collect();
    Ok(RecallPageStats {
        page_id: page_id.to_string(),
        covers: count_covers(conn, page_id)?,
        answers: answers.len() as u32,
        known: answers.iter().filter(|a| a.knew).count() as u32,
        runs: runs.len() as u32,
        last: runs.last().cloned(),
        trend,
    })
}

fn rate_since(answers: &[&Answer], cutoff: &str) -> RecallRate {
    let mut rate = RecallRate::default();
    for a in answers.iter().filter(|a| a.at.as_str() >= cutoff) {
        rate.answers += 1;
        rate.known += u32::from(a.knew);
    }
    rate
}

impl Storage {
    /// Stores one answer as a `recall` learning event. Refuses an empty element or run id.
    pub fn record_recall(&mut self, a: &RecallAnswer) -> Result<()> {
        if a.element_id.is_empty() || a.run_id.is_empty() {
            return Err(StorageError::Limit("a recall answer needs an element id and a run id".into()));
        }
        self.record_learning_event(&LearningEvent {
            id: String::new(),
            page_id: a.page_id.clone(),
            stroke_group_id: None,
            kind: RECALL_KIND.into(),
            payload: serde_json::json!({ "elementId": a.element_id, "knew": a.knew, "runId": a.run_id }),
            created_at: String::new(),
        })
    }

    pub fn recall_page(&self, page_id: &str) -> Result<RecallPageStats> {
        let answers = page_answers(&self.conn, page_id)?;
        page_stats(&self.conn, page_id, &answers)
    }

    /// Statistics over the live pages of the unit's live sections. A page is listed when it has a
    /// live cover or a recall row; the rates count every row of the listed pages, so the rows of a
    /// deleted cover still count. `last7` and `last30` reach back that many days from `now`.
    pub fn recall_unit(&self, unit_id: &str, now: &str) -> Result<RecallUnitStats> {
        let now = OffsetDateTime::parse(now, &Rfc3339)
            .map_err(|e| StorageError::Limit(format!("now is not a timestamp: {e}")))?;
        let cutoff = |days| format_iso(now.to_offset(time::UtcOffset::UTC) - Duration::days(days));
        let mut stmt = self.conn.prepare(
            "SELECT p.id FROM pages p JOIN sections s ON s.id = p.section_id \
             WHERE s.unit_id = ?1 AND p.deleted_at IS NULL AND s.deleted_at IS NULL \
             ORDER BY s.order_index, p.order_index, p.id",
        )?;
        let page_ids = stmt.query_map([unit_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut pages = Vec::new();
        let mut all_answers = Vec::new();
        for id in &page_ids {
            let answers = page_answers(&self.conn, id)?;
            let stats = page_stats(&self.conn, id, &answers)?;
            if stats.covers > 0 || !answers.is_empty() {
                pages.push(stats);
                all_answers.extend(answers);
            }
        }
        let refs: Vec<&Answer> = all_answers.iter().collect();
        Ok(RecallUnitStats {
            covers: pages.iter().map(|p| p.covers).sum(),
            all: rate_since(&refs, ""),
            last7: rate_since(&refs, &cutoff(7)),
            last30: rate_since(&refs, &cutoff(30)),
            pages,
        })
    }

    /// The latest `last` answers for one cover, oldest first (`true` = knew it).
    pub fn recall_element(&self, element_id: &str, last: usize) -> Result<Vec<bool>> {
        // The LIKE only narrows the scan; the parsed payload decides.
        let escaped = element_id.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let mut stmt = self.conn.prepare(
            "SELECT payload FROM learning_events WHERE kind = ?1 \
             AND payload LIKE '%' || ?2 || '%' ESCAPE '\\' ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map(params![RECALL_KIND, escaped], |r| Ok(json_col::<serde_json::Value>(r, 0)))?;
        let mut knew = Vec::new();
        for row in rows {
            if knew.len() >= last {
                break;
            }
            if let Some(a) = row?.ok().and_then(|p| parse_answer(&p, String::new()))
                && a.element_id == element_id
            {
                knew.push(a.knew);
            }
        }
        knew.reverse();
        Ok(knew)
    }

    /// Every recall row of the unit's pages (live or not), oldest first, for the backup. A row
    /// whose payload is not JSON is skipped: one bad row must not fail the whole backup.
    pub fn recall_rows(&self, unit_id: &str) -> Result<Vec<LearningEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.id, e.page_id, e.stroke_group_id, e.kind, e.payload, e.created_at \
             FROM learning_events e JOIN pages p ON p.id = e.page_id \
             JOIN sections s ON s.id = p.section_id \
             WHERE s.unit_id = ?1 AND e.kind = ?2 ORDER BY e.created_at, e.rowid",
        )?;
        let rows = stmt.query_map(params![unit_id, RECALL_KIND], |r| {
            let Ok(payload) = json_col::<serde_json::Value>(r, 4) else {
                return Ok(None);
            };
            Ok(Some(LearningEvent {
                id: r.get(0)?,
                page_id: r.get(1)?,
                stroke_group_id: r.get(2)?,
                kind: r.get(3)?,
                payload,
                created_at: r.get(5)?,
            }))
        })?;
        let mut out = Vec::new();
        for row in rows {
            if let Some(ev) = row? {
                out.push(ev);
            }
        }
        Ok(out)
    }

    /// Stores restored recall rows (ids and times as given) in one transaction, so a backup's
    /// thousands of answers do not each wait for their own commit.
    pub(crate) fn insert_recall_rows(&mut self, rows: &[LearningEvent]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO learning_events (id, page_id, stroke_group_id, kind, payload, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for ev in rows {
                stmt.execute(params![
                    ev.id,
                    ev.page_id,
                    ev.stroke_group_id,
                    RECALL_KIND,
                    serde_json::to_string(&ev.payload)?,
                    ev.created_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
