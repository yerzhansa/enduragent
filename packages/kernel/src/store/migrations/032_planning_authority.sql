CREATE TABLE planning_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  chat_authority_since_ms INTEGER
    CHECK (chat_authority_since_ms IS NULL OR chat_authority_since_ms >= 0),
  device_id TEXT,
  hlc_physical_ms INTEGER,
  hlc_counter INTEGER
) STRICT;

INSERT INTO planning_authority (singleton, chat_authority_since_ms, device_id, hlc_physical_ms, hlc_counter)
VALUES (1, (SELECT MIN(created_at_ms) FROM plan_creation), NULL, NULL, NULL);

CREATE TRIGGER planning_authority_no_delete
BEFORE DELETE ON planning_authority
BEGIN
  SELECT RAISE(ABORT, 'planning authority is durable');
END;

CREATE TRIGGER planning_authority_no_insert
BEFORE INSERT ON planning_authority
BEGIN
  SELECT RAISE(ABORT, 'planning authority already exists');
END;

CREATE TRIGGER planning_authority_no_release
BEFORE UPDATE ON planning_authority
WHEN OLD.chat_authority_since_ms IS NOT NULL
  AND (NEW.chat_authority_since_ms IS NULL OR NEW.chat_authority_since_ms <> OLD.chat_authority_since_ms)
BEGIN
  SELECT RAISE(ABORT, 'Chat planning authority cannot change');
END;
