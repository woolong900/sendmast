-- Rebrand 'sendwalk' → 'SendMast' (display) / 'sendmast' (technical).
-- Historical migrations seeded notification_templates rows that bake the old
-- brand into subject + body_html. Modifying those migration files would
-- trigger a checksum-mismatch and force `prisma migrate dev` to reset the
-- database, so we ship the brand fix as a forward-only UPDATE here.
--
-- Idempotent: REPLACE() leaves rows untouched if the substring isn't found,
-- so re-running this migration on a DB that's already been admin-edited
-- away from the seed text is a no-op.

UPDATE "notification_templates"
SET
  "subject"   = REPLACE("subject", '【sendwalk】', '【SendMast】'),
  "body_html" = REPLACE("body_html", 'sendwalk', 'SendMast');
