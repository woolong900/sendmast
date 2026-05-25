-- Switch from react-email-editor (Unlayer) to easy-email. The two editors
-- store mutually-incompatible JSON schemas in the existing `design_json`
-- column. Rather than expanding the column (or adding a `design_format`
-- discriminator), we simply NULL out the old Unlayer payloads.
--
-- Effect:
--   * Existing emails still render — `html` is preserved verbatim and the
--     send pipeline only ever consumed `html`.
--   * The visual editor will refuse to load these legacy rows (since the
--     IBlock tree is missing) and the UI shows a "this template was created
--     with the legacy editor, please rebuild" banner instead.
--
-- Forward-only and idempotent: re-running this migration on a DB whose
-- design_json is already NULL is a no-op.

UPDATE "email_templates" SET "design_json" = NULL WHERE "design_json" IS NOT NULL;
UPDATE "campaigns"        SET "design_json" = NULL WHERE "design_json" IS NOT NULL;
