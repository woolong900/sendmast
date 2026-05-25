-- Add `editor_mode` to campaigns: which editor (visual / html) produced the body.
-- Default 'visual' so existing rows stay backwards-compatible with the Easy Email
-- drag-drop editor. Stored as TEXT (not enum) so a future 'plain_text' mode is a
-- one-line code change instead of a schema migration.
ALTER TABLE "campaigns"
  ADD COLUMN "editor_mode" TEXT NOT NULL DEFAULT 'visual';
