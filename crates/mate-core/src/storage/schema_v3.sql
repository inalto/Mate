-- Mate schema v3: provenance of imported pages (GoodNotes, Notability, OneNote, ...).
-- JSON `{source, sourcePageId, sourceFingerprint}`; NULL for pages created in Mate. Re-importing
-- the same file into a unit skips pages whose `sourceFingerprint` is already there.
ALTER TABLE pages ADD COLUMN import_metadata TEXT;
