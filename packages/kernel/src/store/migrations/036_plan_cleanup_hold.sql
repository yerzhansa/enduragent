CREATE TABLE plan_cleanup_hold (
  plan_id TEXT PRIMARY KEY REFERENCES plan(id) ON DELETE CASCADE,
  replacement_plan_id TEXT NOT NULL REFERENCES plan(id),
  held_at_ms INTEGER NOT NULL CHECK (held_at_ms >= 0),
  released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= held_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= held_at_ms),
  CHECK (replacement_plan_id <> plan_id)
) STRICT;

CREATE INDEX idx_plan_cleanup_hold_replacement
  ON plan_cleanup_hold (replacement_plan_id, released_at_ms, plan_id);
