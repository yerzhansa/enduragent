ALTER TABLE pending_provider_mutations
ADD COLUMN recovery TEXT NOT NULL DEFAULT 'replay'
CHECK (recovery IN ('replay', 'fence'));

CREATE TABLE device_grant_gate (
  gate_id INTEGER PRIMARY KEY CHECK (gate_id = 1),
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
