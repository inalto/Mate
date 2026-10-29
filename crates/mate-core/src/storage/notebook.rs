//! Notebook tree CRUD (bookshelves → units → sections → pages) and the trash.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::{Result, Storage, StorageError, enum_col, enum_to_sql, json_col, opt_json_col};
use crate::model::{Bookshelf, Page, Section, Unit, format_iso, now_iso};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityKind {
    Bookshelf,
    Unit,
    Section,
    Page,
}

impl EntityKind {
    fn table(self) -> &'static str {
        match self {
            EntityKind::Bookshelf => "bookshelves",
            EntityKind::Unit => "units",
            EntityKind::Section => "sections",
            EntityKind::Page => "pages",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTree {
    pub bookshelves: Vec<Bookshelf>,
    pub units: Vec<Unit>,
    pub sections: Vec<Section>,
    pub pages: Vec<Page>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub kind: EntityKind,
    pub id: String,
    pub title: String,
    pub deleted_at: String,
}

const BOOKSHELF_COLS: &str =
    r#"id, title, icon, color, "order", is_expanded, created_at, updated_at, deleted_at, version, parent_id"#;
const UNIT_COLS: &str = "id, title, icon, color, is_favourite, bookshelf_id, is_expanded, \
     order_index, created_at, updated_at, deleted_at, version";
const SECTION_COLS: &str = "id, unit_id, title, color, icon, order_index, is_expanded, \
     created_at, updated_at, deleted_at, version";
const PAGE_COLS: &str = "id, section_id, parent_id, title, is_expanded, is_favourite, depth, \
     mode, background_config, page_width, page_height, thumbnail_version, icon, order_index, \
     created_at, updated_at, deleted_at, version, import_metadata";

fn bookshelf_from_row(r: &Row) -> rusqlite::Result<Bookshelf> {
    Ok(Bookshelf {
        id: r.get(0)?,
        title: r.get(1)?,
        icon: r.get(2)?,
        color: r.get(3)?,
        order: r.get(4)?,
        is_expanded: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
        version: r.get(9)?,
        parent_id: r.get(10)?,
    })
}

fn unit_from_row(r: &Row) -> rusqlite::Result<Unit> {
    Ok(Unit {
        id: r.get(0)?,
        title: r.get(1)?,
        icon: r.get(2)?,
        color: r.get(3)?,
        is_favourite: r.get(4)?,
        bookshelf_id: r.get(5)?,
        is_expanded: r.get(6)?,
        order_index: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        deleted_at: r.get(10)?,
        version: r.get(11)?,
    })
}

fn section_from_row(r: &Row) -> rusqlite::Result<Section> {
    Ok(Section {
        id: r.get(0)?,
        unit_id: r.get(1)?,
        title: r.get(2)?,
        color: r.get(3)?,
        icon: r.get(4)?,
        order_index: r.get(5)?,
        is_expanded: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        deleted_at: r.get(9)?,
        version: r.get(10)?,
    })
}

fn page_from_row(r: &Row) -> rusqlite::Result<Page> {
    Ok(Page {
        id: r.get(0)?,
        section_id: r.get(1)?,
        parent_id: r.get(2)?,
        title: r.get(3)?,
        is_expanded: r.get(4)?,
        is_favourite: r.get(5)?,
        depth: r.get(6)?,
        mode: enum_col(r, 7)?,
        background_config: json_col(r, 8)?,
        page_width: r.get(9)?,
        page_height: r.get(10)?,
        thumbnail_version: r.get(11)?,
        icon: r.get(12)?,
        order_index: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        deleted_at: r.get(16)?,
        version: r.get(17)?,
        import_metadata: opt_json_col(r, 18)?,
    })
}

fn query_all<T>(
    conn: &Connection,
    sql: &str,
    map: fn(&Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<rusqlite::Result<Vec<T>>>()?)
}

fn ids(conn: &Connection, sql: &str, param: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map([param], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
}

/// Page `?1` and every page below it via `parent_id`.
const PAGE_SUBTREE: &str = "WITH RECURSIVE sub(id) AS ( \
         SELECT id FROM pages WHERE id = ?1 \
         UNION SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id) \
     SELECT id FROM sub";
/// Every page of section `?1`, including nested pages.
const SECTION_PAGES: &str = "WITH RECURSIVE sub(id) AS ( \
         SELECT id FROM pages WHERE section_id = ?1 \
         UNION SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id) \
     SELECT id FROM sub";

/// Bookshelf `?1` and every folder below it via `parent_id`.
const FOLDER_SUBTREE: &str = "WITH RECURSIVE sub(id) AS ( \
         SELECT id FROM bookshelves WHERE id = ?1 \
         UNION SELECT b.id FROM bookshelves b JOIN sub ON b.parent_id = sub.id) \
     SELECT id FROM sub";

/// A row plus all of its descendants, grouped by table. Elements are addressed via `pages`.
#[derive(Default)]
struct Subtree {
    bookshelves: Vec<String>,
    units: Vec<String>,
    sections: Vec<String>,
    pages: Vec<String>,
}

impl Subtree {
    fn collect(conn: &Connection, kind: EntityKind, id: &str) -> Result<Subtree> {
        let mut sub = Subtree::default();
        match kind {
            // A folder's descendants are its subfolders; the units it groups are detached
            // instead (see `detach_units`), so they are never trashed or purged with it.
            EntityKind::Bookshelf => sub.bookshelves = ids(conn, FOLDER_SUBTREE, id)?,
            EntityKind::Unit => sub.units.push(id.to_owned()),
            EntityKind::Section => sub.sections.push(id.to_owned()),
            EntityKind::Page => sub.pages = ids(conn, PAGE_SUBTREE, id)?,
        }
        for unit in &sub.units {
            let found = ids(conn, "SELECT id FROM sections WHERE unit_id = ?1", unit)?;
            sub.sections.extend(found);
        }
        for section in &sub.sections {
            let found = ids(conn, SECTION_PAGES, section)?;
            sub.pages.extend(found);
        }
        Ok(sub)
    }

    /// `(table, key column, keys)` from leaves to root.
    fn targets(&self) -> [(&'static str, &'static str, &[String]); 5] {
        [
            ("elements", "page_id", &self.pages),
            ("pages", "id", &self.pages),
            ("sections", "id", &self.sections),
            ("units", "id", &self.units),
            ("bookshelves", "id", &self.bookshelves),
        ]
    }
}

/// `deleted_at` of the row, or `NotFound` if the row does not exist.
fn deleted_at_of(conn: &Connection, kind: EntityKind, id: &str) -> Result<Option<String>> {
    conn.query_row(
        &format!("SELECT deleted_at FROM {} WHERE id = ?1", kind.table()),
        [id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| StorageError::NotFound(format!("{kind:?} {id}")))
}

/// Detaches every unit from the given bookshelves (units stay live; `version` bumped).
fn detach_units(conn: &Connection, shelf_ids: &[String], now: &str) -> Result<()> {
    let mut stmt = conn.prepare(
        "UPDATE units SET bookshelf_id = NULL, updated_at = ?2, version = version + 1 \
         WHERE bookshelf_id = ?1",
    )?;
    for id in shelf_ids {
        stmt.execute(params![id, now])?;
    }
    Ok(())
}

/// Checks that bookshelf `id` may sit in `parent`: the parent exists, is not in the trash, and
/// is neither `id` itself nor one of its subfolders.
fn check_folder_parent(conn: &Connection, id: &str, parent: Option<&str>) -> Result<()> {
    let Some(parent) = parent else {
        return Ok(());
    };
    if deleted_at_of(conn, EntityKind::Bookshelf, parent)?.is_some() {
        return Err(StorageError::NotFound(format!("Bookshelf {parent} (in the trash)")));
    }
    if ids(conn, FOLDER_SUBTREE, id)?.iter().any(|d| d == parent) {
        return Err(StorageError::FolderCycle);
    }
    Ok(())
}

fn purge_in(conn: &Connection, kind: EntityKind, id: &str) -> Result<()> {
    deleted_at_of(conn, kind, id)?;
    let sub = Subtree::collect(conn, kind, id)?;
    detach_units(conn, &sub.bookshelves, &now_iso())?;
    for (table, key, keys) in sub.targets() {
        let mut stmt = conn.prepare(&format!("DELETE FROM {table} WHERE {key} = ?1"))?;
        for k in keys {
            stmt.execute([k])?;
        }
    }
    Ok(())
}

const TRASH_SQL: &str = "\
    SELECT 'bookshelf', b.id, b.title, b.deleted_at FROM bookshelves b \
        LEFT JOIN bookshelves pb ON pb.id = b.parent_id \
        WHERE b.deleted_at IS NOT NULL AND pb.deleted_at IS NULL \
    UNION ALL \
    SELECT 'unit', u.id, u.title, u.deleted_at FROM units u \
        LEFT JOIN bookshelves b ON b.id = u.bookshelf_id \
        WHERE u.deleted_at IS NOT NULL AND b.deleted_at IS NULL \
    UNION ALL \
    SELECT 'section', s.id, s.title, s.deleted_at FROM sections s \
        JOIN units u ON u.id = s.unit_id \
        WHERE s.deleted_at IS NOT NULL AND u.deleted_at IS NULL \
    UNION ALL \
    SELECT 'page', p.id, p.title, p.deleted_at FROM pages p \
        JOIN sections s ON s.id = p.section_id \
        LEFT JOIN pages pp ON pp.id = p.parent_id \
        WHERE p.deleted_at IS NOT NULL \
          AND CASE WHEN p.parent_id IS NULL THEN s.deleted_at IS NULL \
                   ELSE pp.deleted_at IS NULL END \
    ORDER BY 4 DESC";

fn list_trash_in(conn: &Connection) -> Result<Vec<TrashItem>> {
    query_all(conn, TRASH_SQL, |r| {
        Ok(TrashItem {
            kind: enum_col(r, 0)?,
            id: r.get(1)?,
            title: r.get(2)?,
            deleted_at: r.get(3)?,
        })
    })
}

impl Storage {
    /// All non-deleted bookshelves, units, sections and pages, each in display order.
    pub fn list_tree(&self) -> Result<NotebookTree> {
        let c = &self.conn;
        Ok(NotebookTree {
            bookshelves: query_all(
                c,
                &format!(
                    r#"SELECT {BOOKSHELF_COLS} FROM bookshelves WHERE deleted_at IS NULL ORDER BY "order", rowid"#
                ),
                bookshelf_from_row,
            )?,
            units: query_all(
                c,
                &format!(
                    "SELECT {UNIT_COLS} FROM units WHERE deleted_at IS NULL ORDER BY order_index, rowid"
                ),
                unit_from_row,
            )?,
            sections: query_all(
                c,
                &format!(
                    "SELECT {SECTION_COLS} FROM sections WHERE deleted_at IS NULL ORDER BY order_index, rowid"
                ),
                section_from_row,
            )?,
            pages: query_all(
                c,
                &format!(
                    "SELECT {PAGE_COLS} FROM pages WHERE deleted_at IS NULL ORDER BY order_index, rowid"
                ),
                page_from_row,
            )?,
        })
    }

    /// Inserts or updates a bookshelf (folder). Its `parent_id` must name a live folder that is
    /// not the bookshelf itself or one of its subfolders ([`StorageError::FolderCycle`]).
    pub fn upsert_bookshelf(&mut self, b: &Bookshelf) -> Result<()> {
        let tx = self.conn.transaction()?;
        check_folder_parent(&tx, &b.id, b.parent_id.as_deref())?;
        tx.execute(
            &format!(
                r#"INSERT INTO bookshelves ({BOOKSHELF_COLS})
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)
                   ON CONFLICT(id) DO UPDATE SET
                     title = excluded.title, icon = excluded.icon, color = excluded.color,
                     "order" = excluded."order", is_expanded = excluded.is_expanded,
                     parent_id = excluded.parent_id,
                     updated_at = excluded.updated_at, version = bookshelves.version + 1"#
            ),
            params![
                b.id,
                b.title,
                b.icon,
                b.color,
                b.order,
                b.is_expanded,
                b.created_at,
                now_iso(),
                b.deleted_at,
                b.parent_id
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Moves live bookshelf `id` into folder `parent` (`None`: the Library root). Refuses a
    /// trashed or unknown parent (`NotFound`) and the folder itself or a subfolder
    /// ([`StorageError::FolderCycle`]).
    pub fn move_bookshelf(&mut self, id: &str, parent: Option<&str>) -> Result<()> {
        let tx = self.conn.transaction()?;
        if deleted_at_of(&tx, EntityKind::Bookshelf, id)?.is_some() {
            return Err(StorageError::NotFound(format!("Bookshelf {id} (in the trash)")));
        }
        check_folder_parent(&tx, id, parent)?;
        tx.execute(
            "UPDATE bookshelves SET parent_id = ?2, updated_at = ?3, version = version + 1 \
             WHERE id = ?1",
            params![id, parent, now_iso()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn upsert_unit(&mut self, u: &Unit) -> Result<()> {
        self.conn.execute(
            &format!(
                "INSERT INTO units ({UNIT_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title, icon = excluded.icon, color = excluded.color,
                   is_favourite = excluded.is_favourite, bookshelf_id = excluded.bookshelf_id,
                   is_expanded = excluded.is_expanded, order_index = excluded.order_index,
                   updated_at = excluded.updated_at, version = units.version + 1"
            ),
            params![
                u.id,
                u.title,
                u.icon,
                u.color,
                u.is_favourite,
                u.bookshelf_id,
                u.is_expanded,
                u.order_index,
                u.created_at,
                now_iso(),
                u.deleted_at
            ],
        )?;
        Ok(())
    }

    pub fn upsert_section(&mut self, s: &Section) -> Result<()> {
        self.conn.execute(
            &format!(
                "INSERT INTO sections ({SECTION_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)
                 ON CONFLICT(id) DO UPDATE SET
                   unit_id = excluded.unit_id, title = excluded.title, color = excluded.color,
                   icon = excluded.icon, order_index = excluded.order_index,
                   is_expanded = excluded.is_expanded,
                   updated_at = excluded.updated_at, version = sections.version + 1"
            ),
            params![
                s.id,
                s.unit_id,
                s.title,
                s.color,
                s.icon,
                s.order_index,
                s.is_expanded,
                s.created_at,
                now_iso(),
                s.deleted_at
            ],
        )?;
        Ok(())
    }

    /// Increments the page's thumbnail version (a cache-buster for the stored image) and returns
    /// it. Not an edit: `version` and `updated_at` stay untouched.
    pub fn bump_thumbnail_version(&mut self, page_id: &str) -> Result<i64> {
        self.conn
            .query_row(
                "UPDATE pages SET thumbnail_version = thumbnail_version + 1
                 WHERE id = ?1 RETURNING thumbnail_version",
                params![page_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("page {page_id}")))
    }

    pub fn upsert_page(&mut self, p: &Page) -> Result<()> {
        upsert_page_in(&self.conn, p)
    }

    /// Inserts (or updates) a page and its elements in one transaction: either both land or
    /// neither does. Element limits are checked as in [`Storage::upsert_elements`].
    pub fn upsert_page_with_elements(
        &mut self,
        page: &Page,
        elements: &[crate::model::Element],
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        upsert_page_in(&tx, page)?;
        super::elements::upsert_elements_in(&tx, elements)?;
        tx.commit()?;
        Ok(())
    }

    /// Moves the row and all live descendants (and their elements) to the trash with one
    /// shared timestamp. Already-deleted rows keep their own timestamp. No-op if the row is
    /// already in the trash. A bookshelf's descendants are its subfolders; the units in any of
    /// them are detached (they become unfiled), never trashed.
    pub fn soft_delete(&mut self, kind: EntityKind, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        if deleted_at_of(&tx, kind, id)?.is_some() {
            return Ok(());
        }
        let stamp = now_iso();
        let sub = Subtree::collect(&tx, kind, id)?;
        detach_units(&tx, &sub.bookshelves, &stamp)?;
        for (table, key, keys) in sub.targets() {
            let mut stmt = tx.prepare(&format!(
                "UPDATE {table} SET deleted_at = ?1, updated_at = ?1, version = version + 1 \
                 WHERE {key} = ?2 AND deleted_at IS NULL"
            ))?;
            for k in keys {
                stmt.execute(params![stamp, k])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Restores the row and the descendants that were trashed together with it (same
    /// `deleted_at`). Items deleted separately before stay in the trash. No-op if not deleted.
    /// A folder whose parent folder is not live (still in the trash) comes back at the root.
    pub fn restore(&mut self, kind: EntityKind, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        let Some(stamp) = deleted_at_of(&tx, kind, id)? else {
            return Ok(());
        };
        let now = now_iso();
        let sub = Subtree::collect(&tx, kind, id)?;
        for (table, key, keys) in sub.targets() {
            let mut stmt = tx.prepare(&format!(
                "UPDATE {table} SET deleted_at = NULL, updated_at = ?1, version = version + 1 \
                 WHERE {key} = ?2 AND deleted_at = ?3"
            ))?;
            for k in keys {
                stmt.execute(params![now, k, stamp])?;
            }
        }
        if kind == EntityKind::Bookshelf {
            tx.execute(
                "UPDATE bookshelves SET parent_id = NULL WHERE id = ?1 AND parent_id IN \
                 (SELECT id FROM bookshelves WHERE deleted_at IS NOT NULL)",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Top-most trashed items (those whose parent is not itself in the trash), newest first.
    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        list_trash_in(&self.conn)
    }

    /// Hard-deletes the row, all descendants and their elements. Purging a bookshelf removes its
    /// subfolders too, and detaches their units without ever deleting them.
    pub fn purge(&mut self, kind: EntityKind, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        purge_in(&tx, kind, id)?;
        tx.commit()?;
        Ok(())
    }

    /// Purges top-most trash items deleted more than `days` days ago; returns how many.
    pub fn purge_older_than(&mut self, days: i64) -> Result<usize> {
        let cutoff = format_iso(OffsetDateTime::now_utc() - Duration::days(days));
        let tx = self.conn.transaction()?;
        let old: Vec<TrashItem> = list_trash_in(&tx)?
            .into_iter()
            .filter(|item| item.deleted_at < cutoff)
            .collect();
        for item in &old {
            purge_in(&tx, item.kind, &item.id)?;
        }
        tx.commit()?;
        Ok(old.len())
    }
}

/// Inserts or updates a page row. A missing `import_metadata` keeps the stored one, so a page
/// edited by a client that does not know the field keeps its import fingerprint.
fn upsert_page_in(conn: &Connection, p: &Page) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO pages ({PAGE_COLS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, 1, ?18)
             ON CONFLICT(id) DO UPDATE SET
               section_id = excluded.section_id, parent_id = excluded.parent_id,
               title = excluded.title, is_expanded = excluded.is_expanded,
               is_favourite = excluded.is_favourite, depth = excluded.depth,
               mode = excluded.mode, background_config = excluded.background_config,
               page_width = excluded.page_width, page_height = excluded.page_height,
               thumbnail_version = MAX(pages.thumbnail_version, excluded.thumbnail_version),
               icon = excluded.icon,
               order_index = excluded.order_index,
               import_metadata = COALESCE(excluded.import_metadata, pages.import_metadata),
               updated_at = excluded.updated_at, version = pages.version + 1"
        ),
        params![
            p.id,
            p.section_id,
            p.parent_id,
            p.title,
            p.is_expanded,
            p.is_favourite,
            p.depth,
            enum_to_sql(&p.mode)?,
            serde_json::to_string(&p.background_config)?,
            p.page_width,
            p.page_height,
            p.thumbnail_version,
            p.icon,
            p.order_index,
            p.created_at,
            now_iso(),
            p.deleted_at,
            p.import_metadata
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?
        ],
    )?;
    Ok(())
}
