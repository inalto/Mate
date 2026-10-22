-- Mate schema v1.
-- Connection pragmas (foreign_keys=ON on every open, journal_mode=WAL for file-backed
-- databases) are applied by Storage::open / open_in_memory, not here: both are
-- per-connection settings and journal_mode cannot change inside the migration transaction.

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE bookshelves (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    icon        TEXT,
    color       TEXT,
    "order"     INTEGER NOT NULL DEFAULT 0,
    is_expanded INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE units (
    id           TEXT PRIMARY KEY NOT NULL,
    title        TEXT NOT NULL,
    icon         TEXT,
    color        TEXT,
    is_favourite INTEGER NOT NULL DEFAULT 0,
    bookshelf_id TEXT REFERENCES bookshelves(id) ON DELETE SET NULL,
    is_expanded  INTEGER NOT NULL DEFAULT 1,
    order_index  INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT,
    version      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sections (
    id          TEXT PRIMARY KEY NOT NULL,
    unit_id     TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    color       TEXT NOT NULL,
    icon        TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    is_expanded INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE pages (
    id                TEXT PRIMARY KEY NOT NULL,
    section_id        TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    parent_id         TEXT REFERENCES pages(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    is_expanded       INTEGER NOT NULL DEFAULT 0,
    is_favourite      INTEGER NOT NULL DEFAULT 0,
    depth             INTEGER NOT NULL DEFAULT 0,
    mode              TEXT NOT NULL,
    background_config TEXT NOT NULL,
    page_width        REAL,
    page_height       REAL,
    thumbnail_version INTEGER NOT NULL DEFAULT 0,
    icon              TEXT,
    order_index       INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    version           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE elements (
    id             TEXT PRIMARY KEY NOT NULL,
    page_id        TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,
    points         TEXT NOT NULL,
    color          TEXT NOT NULL,
    width          REAL NOT NULL,
    height         REAL,
    is_highlighter INTEGER NOT NULL DEFAULT 0,
    pen_style      TEXT,
    image_url      TEXT,
    shape_type     TEXT,
    fill_color     TEXT,
    box_width      REAL,
    box_height     REAL,
    content        TEXT,
    classification TEXT,
    ui_group_id    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT,
    version        INTEGER NOT NULL DEFAULT 1,
    last_write_id  TEXT
);

CREATE INDEX idx_elements_page_deleted ON elements(page_id, deleted_at);
CREATE INDEX idx_pages_section ON pages(section_id);
CREATE INDEX idx_pages_parent ON pages(parent_id);
CREATE INDEX idx_sections_unit ON sections(unit_id);
CREATE INDEX idx_units_bookshelf ON units(bookshelf_id);
