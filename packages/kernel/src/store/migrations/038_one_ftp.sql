CREATE TABLE ftp_proposal_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE ftp_accepted (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  athlete_id TEXT NOT NULL CHECK (length(athlete_id) BETWEEN 1 AND 128),
  watts INTEGER NOT NULL CHECK (watts BETWEEN 1 AND 9999),
  previous_watts INTEGER CHECK (previous_watts IS NULL OR previous_watts BETWEEN 1 AND 9999),
  basis TEXT NOT NULL CHECK (basis IN ('planned-test','drift')),
  set_at_ms INTEGER NOT NULL CHECK (set_at_ms >= 0),
  icu_updated_ms INTEGER CHECK (icu_updated_ms IS NULL OR icu_updated_ms >= 0),
  written_at_ms INTEGER NOT NULL CHECK (written_at_ms >= 0)
) STRICT;

CREATE INDEX idx_ftp_accepted_set ON ftp_accepted (set_at_ms, id);
