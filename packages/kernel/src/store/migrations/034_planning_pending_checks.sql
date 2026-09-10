ALTER TABLE plan_creation ADD COLUMN pending_check_json TEXT CHECK (
  pending_check_json IS NULL OR (
    json_valid(pending_check_json)
    AND json_type(pending_check_json) = 'object'
    AND status IN ('in-progress', 'review')
  )
);

ALTER TABLE planning_plan ADD COLUMN pending_check_json TEXT CHECK (
  pending_check_json IS NULL OR (
    json_valid(pending_check_json)
    AND json_type(pending_check_json) = 'object'
    AND status = 'active'
  )
);
