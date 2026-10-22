//! SQLite persistence for the notebook tree and page elements.

mod elements;
mod notebook;

use std::path::Path;

use rusqlite::types::Type;
use rusqlite::{Connection, Row};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub use notebook::{EntityKind, NotebookTree, TrashItem};

const SCHEMA_V1: &str = include_str!("schema.sql");
const CURRENT_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("limit exceeded: {0}")]
    Limit(String),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StorageError>;

pub struct Storage {
    conn: Connection,
}

impl Storage {
    /// Opens (creating if needed) a file-backed database in WAL mode and migrates it.
    pub fn open(path: &Path) -> Result<Storage> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    /// Opens a fresh in-memory database (tests, scratch use) and migrates it.
    pub fn open_in_memory() -> Result<Storage> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Storage> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        Ok(Storage { conn })
    }
}

fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |r| r.get(0),
    )?;
    if current < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(SCHEMA_V1)?;
        tx.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [CURRENT_VERSION],
        )?;
        tx.commit()?;
    }
    Ok(())
}

/// Serde string form of a unit-variant enum, e.g. `ElementType::TextBox` → `"text-box"`.
fn enum_to_sql<T: Serialize>(value: &T) -> Result<String> {
    match serde_json::to_value(value)? {
        serde_json::Value::String(s) => Ok(s),
        other => Err(serde_json::Error::io(std::io::Error::other(format!(
            "expected enum to serialize as a string, got {other}"
        )))
        .into()),
    }
}

/// Reads an enum column stored in its serde string form.
fn enum_col<T: DeserializeOwned>(row: &Row, idx: usize) -> rusqlite::Result<T> {
    let raw: String = row.get(idx)?;
    serde_json::from_value(serde_json::Value::String(raw)).map_err(|e| conversion_err(idx, e))
}

/// Optional variant of [`enum_col`].
fn opt_enum_col<T: DeserializeOwned>(row: &Row, idx: usize) -> rusqlite::Result<Option<T>> {
    let raw: Option<String> = row.get(idx)?;
    raw.map(|s| serde_json::from_value(serde_json::Value::String(s)))
        .transpose()
        .map_err(|e| conversion_err(idx, e))
}

/// Reads a JSON text column into `T`.
fn json_col<T: DeserializeOwned>(row: &Row, idx: usize) -> rusqlite::Result<T> {
    let raw: String = row.get(idx)?;
    serde_json::from_str(&raw).map_err(|e| conversion_err(idx, e))
}

/// Optional variant of [`json_col`].
fn opt_json_col<T: DeserializeOwned>(row: &Row, idx: usize) -> rusqlite::Result<Option<T>> {
    let raw: Option<String> = row.get(idx)?;
    raw.map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(|e| conversion_err(idx, e))
}

fn conversion_err(idx: usize, e: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(idx, Type::Text, Box::new(e))
}
