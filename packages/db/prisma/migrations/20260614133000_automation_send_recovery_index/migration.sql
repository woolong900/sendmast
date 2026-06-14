-- worker-sender scans stale pending automation sends every tick to recover
-- records whose Redis enqueue was interrupted.
CREATE INDEX "shop_automation_sends_status_created_at_idx"
  ON "shop_automation_sends" ("status", "created_at");
