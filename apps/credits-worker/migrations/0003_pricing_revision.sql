CREATE TABLE pricing_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CONSTRAINT pricing_revision_conflict CHECK (revision >= 0)
);
INSERT INTO pricing_revision (id, revision) VALUES (1, 0);
