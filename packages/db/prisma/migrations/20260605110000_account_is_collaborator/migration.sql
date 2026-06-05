-- Account type flag. Normal tenants (false) get the softened analytics view
-- (soft bounces folded into 送达, 弹回邮箱率 hidden); collaborators (true) see
-- the real deliverability data.
ALTER TABLE "accounts" ADD COLUMN "is_collaborator" BOOLEAN NOT NULL DEFAULT false;
