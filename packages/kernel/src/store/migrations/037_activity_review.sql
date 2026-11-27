CREATE TABLE activity_review (
  activity_id TEXT PRIMARY KEY
    CHECK (
      length(activity_id) = 64
      AND activity_id = lower(activity_id)
      AND activity_id NOT GLOB '*[^0-9a-f]*'
    ),
  verdict_state TEXT NOT NULL
    CHECK (verdict_state IN ('not-written','writing','kept','failed')),
  verdict_for TEXT CHECK (verdict_for IS NULL OR verdict_for IN ('no-workout','workout')),
  verdict_plan_workout_id TEXT
    CHECK (
      verdict_plan_workout_id IS NULL
      OR (
        length(verdict_plan_workout_id) = 26
        AND verdict_plan_workout_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
      )
    ),
  verdict_trigger TEXT
    CHECK (verdict_trigger IS NULL OR verdict_trigger IN ('opened','matched','asked')),
  verdict_used_plan INTEGER CHECK (verdict_used_plan IS NULL OR verdict_used_plan IN (0,1)),
  verdict_used_note INTEGER CHECK (verdict_used_note IS NULL OR verdict_used_note IN (0,1)),
  verdict_text TEXT CHECK (verdict_text IS NULL OR length(verdict_text) BETWEEN 1 AND 3000),
  verdict_started_at_ms INTEGER
    CHECK (verdict_started_at_ms IS NULL OR verdict_started_at_ms >= 0),
  verdict_written_at_ms INTEGER
    CHECK (
      verdict_written_at_ms IS NULL
      OR (verdict_started_at_ms IS NOT NULL AND verdict_written_at_ms >= verdict_started_at_ms)
    ),
  replies INTEGER NOT NULL CHECK (replies BETWEEN 0 AND 1000000),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  note_saved_at_ms INTEGER CHECK (note_saved_at_ms IS NULL OR note_saved_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((verdict_state = 'not-written') = (verdict_for IS NULL)),
  CHECK ((verdict_for IS NOT NULL AND verdict_for = 'workout') = (verdict_plan_workout_id IS NOT NULL)),
  CHECK ((verdict_state = 'not-written') = (verdict_trigger IS NULL)),
  CHECK ((verdict_state = 'not-written') = (verdict_used_plan IS NULL)),
  CHECK ((verdict_state = 'not-written') = (verdict_used_note IS NULL)),
  CHECK ((verdict_state = 'not-written') = (verdict_started_at_ms IS NULL)),
  CHECK ((verdict_state = 'kept') = (verdict_text IS NOT NULL)),
  CHECK ((verdict_state = 'kept') = (verdict_written_at_ms IS NOT NULL)),
  CHECK (verdict_state = 'not-written' OR replies >= 1),
  CHECK ((note IS NULL) = (note_saved_at_ms IS NULL))
) STRICT;
