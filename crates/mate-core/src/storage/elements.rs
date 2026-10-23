//! Page elements (strokes, shapes, boxes, …): load, batched upsert with limits, soft delete.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::recognition::invalidate_in;
use super::{
    Result, Storage, StorageError, enum_col, enum_to_sql, json_col, opt_enum_col, opt_json_col,
};
use crate::model::{Element, now_iso};

/// Maximum live elements on one page.
pub(crate) const MAX_ELEMENTS_PER_PAGE: i64 = 5000;
/// Maximum points in one element.
pub(crate) const MAX_POINTS_PER_STROKE: usize = 50_000;

const ELEMENT_COLS: &str = "id, page_id, type, points, color, width, height, is_highlighter, \
     pen_style, image_url, shape_type, fill_color, box_width, box_height, content, \
     classification, ui_group_id, created_at, updated_at, deleted_at, version, last_write_id";

/// The parts of an element that change what its ink looks like to the tutor, in stored form.
#[derive(PartialEq)]
struct InkState {
    page_id: String,
    r#type: String,
    points: String,
    image_url: Option<String>,
    is_highlighter: bool,
    height: Option<f64>,
    shape_type: Option<String>,
    box_width: Option<f64>,
    box_height: Option<f64>,
    content: Option<String>,
    deleted: bool,
}

fn element_from_row(r: &Row) -> rusqlite::Result<Element> {
    Ok(Element {
        id: r.get(0)?,
        page_id: r.get(1)?,
        r#type: enum_col(r, 2)?,
        points: json_col(r, 3)?,
        color: r.get(4)?,
        width: r.get(5)?,
        height: r.get(6)?,
        is_highlighter: r.get(7)?,
        pen_style: opt_enum_col(r, 8)?,
        image_url: r.get(9)?,
        shape_type: opt_enum_col(r, 10)?,
        fill_color: r.get(11)?,
        box_width: r.get(12)?,
        box_height: r.get(13)?,
        content: opt_json_col(r, 14)?,
        classification: opt_json_col(r, 15)?,
        ui_group_id: r.get(16)?,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
        deleted_at: r.get(19)?,
        version: r.get(20)?,
        last_write_id: r.get(21)?,
    })
}

impl Storage {
    /// Live elements of a page, oldest first.
    pub fn load_elements(&self, page_id: &str) -> Result<Vec<Element>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {ELEMENT_COLS} FROM elements \
             WHERE page_id = ?1 AND deleted_at IS NULL ORDER BY created_at, rowid"
        ))?;
        let rows = stmt.query_map([page_id], element_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Number of live elements on a page.
    pub fn count_elements(&self, page_id: &str) -> Result<i64> {
        count_in(&self.conn, page_id)
    }

    /// Inserts or updates elements in one transaction. Inserts start at `version` 1; updates
    /// bump the stored version. `updated_at` is always stamped now; `created_at` is kept from
    /// the first insert; `deleted_at` is taken from the input (so an undone erase revives).
    /// Limits are checked for the whole batch before anything is written.
    ///
    /// Tutor verdicts of groups containing an element whose ink changed (page, type, points,
    /// box size, shape, content, image, highlighter or deleted state) are invalidated in the same
    /// transaction and its `ink_updated_at` is stamped (new rows get it too); style-only edits
    /// (colour, width, pen) and unchanged re-saves keep both.
    pub fn upsert_elements(&mut self, elements: &[Element]) -> Result<()> {
        let tx = self.conn.transaction()?;
        upsert_elements_in(&tx, elements)?;
        tx.commit()?;
        Ok(())
    }

    /// Every asset id referenced by any element row (`image_url` and `content.pdfSourceKey`),
    /// including soft-deleted rows: the trash can be restored. Purged rows are gone.
    pub fn referenced_asset_ids(&self) -> Result<std::collections::HashSet<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT image_url, content FROM elements              WHERE image_url IS NOT NULL OR (content IS NOT NULL AND content LIKE '%pdfSourceKey%')",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))?;
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            let (url, content) = row?;
            ids.extend(url);
            if let Some(key) = content
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                .and_then(|v| v.get("pdfSourceKey").and_then(|k| k.as_str()).map(str::to_owned))
            {
                ids.insert(key);
            }
        }
        Ok(ids)
    }

    /// Soft-deletes elements by id (stamps `deleted_at`, bumps `version`) and, in the same
    /// transaction, invalidates the tutor verdicts of the groups they belonged to.
    pub fn delete_elements(&mut self, ids: &[String]) -> Result<()> {
        let now = now_iso();
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE elements SET deleted_at = ?1, updated_at = ?1, ink_updated_at = ?1, version = version + 1 \
                 WHERE id = ?2 AND deleted_at IS NULL",
            )?;
            for id in ids {
                stmt.execute(params![now, id])?;
            }
        }
        invalidate_in(&tx, ids)?;
        tx.commit()?;
        Ok(())
    }
}

/// [`Storage::upsert_elements`] inside the caller's transaction (limits checked first).
pub(crate) fn upsert_elements_in(tx: &Connection, elements: &[Element]) -> Result<()> {
    check_limits(tx, elements)?;
    let now = now_iso();
    let mut changed: Vec<String> = Vec::new();
    {
        let mut prev = tx.prepare(
            "SELECT page_id, type, points, height, shape_type, box_width, box_height, content, deleted_at,
             image_url, is_highlighter FROM elements WHERE id = ?1",
        )?;
        let mut stmt = tx.prepare(&format!(
            "INSERT INTO elements ({ELEMENT_COLS}, ink_updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?19, ?20, 1, ?21, ?19)
             ON CONFLICT(id) DO UPDATE SET
               page_id = excluded.page_id, type = excluded.type, points = excluded.points,
               color = excluded.color, width = excluded.width, height = excluded.height,
               is_highlighter = excluded.is_highlighter, pen_style = excluded.pen_style,
               image_url = excluded.image_url, shape_type = excluded.shape_type,
               fill_color = excluded.fill_color, box_width = excluded.box_width,
               box_height = excluded.box_height, content = excluded.content,
               classification = excluded.classification, ui_group_id = excluded.ui_group_id,
               updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
               version = elements.version + 1, last_write_id = excluded.last_write_id,
               ink_updated_at = CASE WHEN ?22 THEN excluded.ink_updated_at
                                     ELSE elements.ink_updated_at END"
        ))?;
        for e in elements {
            let r#type = enum_to_sql(&e.r#type)?;
            let points = serde_json::to_string(&e.points)?;
            let shape_type = e.shape_type.as_ref().map(enum_to_sql).transpose()?;
            let content = e.content.as_ref().map(serde_json::to_string).transpose()?;
            let stored = prev
                .query_row([&e.id], |r| {
                    Ok(InkState {
                        page_id: r.get(0)?,
                        r#type: r.get(1)?,
                        points: r.get(2)?,
                        height: r.get(3)?,
                        shape_type: r.get(4)?,
                        box_width: r.get(5)?,
                        box_height: r.get(6)?,
                        content: r.get(7)?,
                        deleted: r.get::<_, Option<String>>(8)?.is_some(),
                        image_url: r.get(9)?,
                        is_highlighter: r.get(10)?,
                    })
                })
                .optional()?;
            let incoming = InkState {
                page_id: e.page_id.clone(),
                r#type: r#type.clone(),
                points: points.clone(),
                height: e.height,
                shape_type: shape_type.clone(),
                box_width: e.box_width,
                box_height: e.box_height,
                content: content.clone(),
                deleted: e.deleted_at.is_some(),
                image_url: e.image_url.clone(),
                is_highlighter: e.is_highlighter,
            };
            let ink_changed = stored.is_some_and(|s| s != incoming);
            if ink_changed {
                changed.push(e.id.clone());
            }
            stmt.execute(params![
                e.id,
                e.page_id,
                r#type,
                points,
                e.color,
                e.width,
                e.height,
                e.is_highlighter,
                e.pen_style.as_ref().map(enum_to_sql).transpose()?,
                e.image_url,
                shape_type,
                e.fill_color,
                e.box_width,
                e.box_height,
                content,
                e.classification
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                e.ui_group_id,
                e.created_at,
                now,
                e.deleted_at,
                e.last_write_id,
                ink_changed,
            ])?;
        }
    }
    invalidate_in(tx, &changed)?;
    Ok(())
}

fn count_in(conn: &Connection, page_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM elements WHERE page_id = ?1 AND deleted_at IS NULL",
        [page_id],
        |r| r.get(0),
    )?)
}

/// `Limit` if any element has too many points, or if a page would end up with more than
/// [`MAX_ELEMENTS_PER_PAGE`] live elements after the batch.
fn check_limits(conn: &Connection, elements: &[Element]) -> Result<()> {
    if let Some(e) = elements
        .iter()
        .find(|e| e.points.len() > MAX_POINTS_PER_STROKE)
    {
        return Err(StorageError::Limit(format!(
            "element {} has {} points (max {MAX_POINTS_PER_STROKE})",
            e.id,
            e.points.len()
        )));
    }

    // Ids that would become live on each page.
    let mut incoming: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for e in elements.iter().filter(|e| e.deleted_at.is_none()) {
        incoming.entry(&e.page_id).or_default().insert(&e.id);
    }
    let mut is_live = conn.prepare(
        "SELECT 1 FROM elements WHERE id = ?1 AND page_id = ?2 AND deleted_at IS NULL",
    )?;
    for (page_id, ids) in incoming {
        let mut added = 0i64;
        for id in ids {
            if is_live
                .query_row(params![id, page_id], |_| Ok(()))
                .optional()?
                .is_none()
            {
                added += 1;
            }
        }
        let total = count_in(conn, page_id)? + added;
        if total > MAX_ELEMENTS_PER_PAGE {
            return Err(StorageError::Limit(format!(
                "page {page_id} would have {total} elements (max {MAX_ELEMENTS_PER_PAGE})"
            )));
        }
    }
    Ok(())
}

