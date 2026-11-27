CREATE TABLE plan_icu_copy (
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  plan_workout_id TEXT NOT NULL
    CHECK (
      length(plan_workout_id) = 26
      AND plan_workout_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  date_key INTEGER NOT NULL
    CHECK (
      date_key BETWEEN 10101 AND 99991231
      AND ((date_key / 100) % 100) BETWEEN 1 AND 12
      AND (date_key % 100) BETWEEN 1 AND 31
    ),
  state_kind TEXT NOT NULL
    CHECK (
      state_kind IN (
        'not-sent','on-icu','moving-by-you','changed-in-icu','removed-by-you','kept-as-yours'
      )
    ),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  last_write TEXT NOT NULL CHECK (last_write IN ('none','ok','failed')),
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'calendar-read-failed',
      'calendar-create-failed',
      'calendar-update-failed',
      'calendar-delete-failed'
    )
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (plan_id, plan_workout_id),
  CHECK ((last_write = 'failed') = (last_error_code IS NOT NULL))
) STRICT;

CREATE INDEX idx_plan_icu_copy_plan_date ON plan_icu_copy (plan_id, date_key, plan_workout_id);

CREATE TABLE plan_week_delivery (
  plan_id TEXT PRIMARY KEY REFERENCES plan(id) ON DELETE CASCADE,
  state_kind TEXT NOT NULL CHECK (state_kind IN ('waiting-for-first-approve','approved')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  close_choice_json TEXT NOT NULL DEFAULT '{"kind":"keep-them"}'
    CHECK (json_valid(close_choice_json) AND json_type(close_choice_json) = 'object'),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE planning_calendar_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  week_delivery TEXT NOT NULL CHECK (week_delivery IN ('send-each-week','approve-each-week')),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
