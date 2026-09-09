CREATE TABLE athlete_language (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  language TEXT CHECK (language IS NULL OR length(language) BETWEEN 2 AND 7),
  device_id TEXT NOT NULL,
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT;
