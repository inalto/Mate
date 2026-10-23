-- Mate schema v2: tutor recognitions, learning events, page semantics and full-text search.
-- Applied on top of v1 inside one migration transaction; v1 tables are untouched.

-- One verdict per stroke group. `element_ids`, `transcription` and `bounds` are JSON.
-- `fts_rowid` is the rowid of this row's `recognition_fts` entry (FTS5 rowids survive VACUUM,
-- unlike the implicit rowid of this table).
CREATE TABLE stroke_group_recognition (
    page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    stroke_group_id TEXT NOT NULL,
    element_ids     TEXT NOT NULL,
    kind            TEXT NOT NULL,
    latex           TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    correct         INTEGER,
    code            TEXT NOT NULL,
    domain          TEXT NOT NULL,
    error_nature    TEXT,
    hint            TEXT,
    explanation     TEXT,
    next_steps      TEXT,
    focus_span      TEXT,
    illegible       INTEGER NOT NULL DEFAULT 0,
    transcription   TEXT,
    bounds          TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'user')),
    user_override   INTEGER NOT NULL DEFAULT 0,
    provider        TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    fts_rowid       INTEGER,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (page_id, stroke_group_id)
);

-- Element → group membership, so an edit finds the groups to invalidate by index instead of
-- scanning every row's `element_ids` JSON. Kept in step with `element_ids` by the store.
CREATE TABLE recognition_elements (
    page_id         TEXT NOT NULL,
    stroke_group_id TEXT NOT NULL,
    element_id      TEXT NOT NULL,
    PRIMARY KEY (page_id, stroke_group_id, element_id),
    FOREIGN KEY (page_id, stroke_group_id)
        REFERENCES stroke_group_recognition(page_id, stroke_group_id) ON DELETE CASCADE
);
CREATE INDEX idx_recognition_elements_element ON recognition_elements(element_id);

CREATE VIRTUAL TABLE recognition_fts USING fts5(
    page_id UNINDEXED,
    stroke_group_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- However a recognition row goes (invalidation, supersession, page purge cascade), its search
-- row goes with it.
CREATE TRIGGER stroke_group_recognition_fts_delete
AFTER DELETE ON stroke_group_recognition
WHEN old.fts_rowid IS NOT NULL
BEGIN
    DELETE FROM recognition_fts WHERE rowid = old.fts_rowid;
END;

CREATE TABLE learning_events (
    id              TEXT PRIMARY KEY NOT NULL,
    page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    stroke_group_id TEXT,
    kind            TEXT NOT NULL,
    payload         TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_learning_events_page ON learning_events(page_id, created_at);

CREATE TABLE page_semantics (
    page_id         TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    summary         TEXT,
    suggested_title TEXT,
    topics          TEXT NOT NULL DEFAULT '[]',
    content_hash    TEXT,
    updated_at      TEXT NOT NULL
);
