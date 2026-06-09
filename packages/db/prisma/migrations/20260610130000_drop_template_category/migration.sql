-- DropIndex
DROP INDEX IF EXISTS "email_templates_scope_category_idx";

-- AlterTable
ALTER TABLE "email_templates" DROP COLUMN IF EXISTS "category";
