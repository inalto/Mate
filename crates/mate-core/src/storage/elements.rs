//! Page elements (strokes, shapes, boxes, …): load, batched upsert with limits, soft delete.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{OptionalExtension, Row, params};

use super::{
    Result, Storage, StorageError, enum_col, enum_to_sql, json_col, opt_enum_col, opt_json_col,
};
use crate::model::{Element, now_iso};

/// Maximum live elements on one page.
const MAX_ELEMENTS_PER_PAGE: i64 = 5000;
/// Maximum points in one element.
const MAX_POINTS_PER_STROKE: usize = 50_000;

const ELEMENT_COLS: &str = "id, page_id, type, points, color, width, height, is_highlighter, \
     pen_style, image_url, shape_type, fill_color, box_width, box_height, content, \
     classification, ui_group_id, created_at, updated_at, deleted_at, version, last_write_id";

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
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM elements WHERE page_id = ?1 AND deleted_at IS NULL",
            [page_id],
            |r| r.get(0),
        )?)
    }

    /// Inserts or updates elements in one transaction. Inserts start at `version` 1; updates
    /// bump the stored version. `updated_at` is always stamped now; `created_at` is kept from
    /// the first insert; `deleted_at` is taken from the input (so an undone erase revives).
    /// Limits are checked for the whole batch before anything is written.
    pub fn upsert_elements(&mut self, elements: &[Element]) -> Result<()> {
        self.check_limits(elements)?;
        let now = now_iso();
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(&format!(
                "INSERT INTO elements ({ELEMENT_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                         ?17, ?18, ?19, ?20, 1, ?21)
                 ON CONFLICT(id) DO UPDATE SET
                   page_id = excluded.page_id, type = excluded.type, points = excluded.points,
                   color = excluded.color, width = excluded.width, height = excluded.height,
                   is_highlighter = excluded.is_highlighter, pen_style = excluded.pen_style,
                   image_url = excluded.image_url, shape_type = excluded.shape_type,
                   fill_color = excluded.fill_color, box_width = excluded.box_width,
                   box_height = excluded.box_height, content = excluded.content,
                   classification = excluded.classification, ui_group_id = excluded.ui_group_id,
                   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
                   version = elements.version + 1, last_write_id = excluded.last_write_id"
            ))?;
            for e in elements {
                stmt.execute(params![
                    e.id,
                    e.page_id,
                    enum_to_sql(&e.r#type)?,
                    serde_json::to_string(&e.points)?,
                    e.color,
                    e.width,
                    e.height,
                    e.is_highlighter,
                    e.pen_style.as_ref().map(enum_to_sql).transpose()?,
                    e.image_url,
                    e.shape_type.as_ref().map(enum_to_sql).transpose()?,
                    e.fill_color,
                    e.box_width,
                    e.box_height,
                    e.content.as_ref().map(serde_json::to_string).transpose()?,
                    e.classification
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    e.ui_group_id,
                    e.created_at,
                    now,
                    e.deleted_at,
                    e.last_write_id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// `Limit` if any element has too many points, or if a page would end up with more than
    /// [`MAX_ELEMENTS_PER_PAGE`] live elements after the batch.
    fn check_limits(&self, elements: &[Element]) -> Result<()> {
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
        let mut is_live = self.conn.prepare(
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
            let total = self.count_elements(page_id)? + added;
            if total > MAX_ELEMENTS_PER_PAGE {
                return Err(StorageError::Limit(format!(
                    "page {page_id} would have {total} elements (max {MAX_ELEMENTS_PER_PAGE})"
                )));
            }
        }
        Ok(())
    }

    /// Soft-deletes elements by id (stamps `deleted_at`, bumps `version`).
    pub fn delete_elements(&mut self, ids: &[String]) -> Result<()> {
        let now = now_iso();
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE elements SET deleted_at = ?1, updated_at = ?1, version = version + 1 \
                 WHERE id = ?2 AND deleted_at IS NULL",
            )?;
            for id in ids {
                stmt.execute(params![now, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
