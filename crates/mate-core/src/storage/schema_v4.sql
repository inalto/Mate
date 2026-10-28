-- Mate schema v4: folders. A bookshelf can sit inside another bookshelf; NULL is the root.
-- Existing shelves keep NULL and stay at the top level. Cycles are refused by the storage layer.
ALTER TABLE bookshelves ADD COLUMN parent_id TEXT REFERENCES bookshelves(id) ON DELETE SET NULL;
CREATE INDEX idx_bookshelves_parent ON bookshelves(parent_id);
