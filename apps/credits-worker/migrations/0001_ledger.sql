CREATE TABLE IF NOT EXISTS pricing_policies (
  version INTEGER PRIMARY KEY,
  ratio TEXT NOT NULL,
  apple_commission TEXT NOT NULL,
  openrouter_fee TEXT NOT NULL,
  credits_per_usd INTEGER NOT NULL,
  effective_from TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packs (
  product_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  list_price_usd_millis INTEGER NOT NULL,
  cap_usd_millis INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY (product_id, policy_version)
);
CREATE TABLE IF NOT EXISTS athletes (
  athlete_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  disabled INTEGER NOT NULL,
  refunds_after_use INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS original_transactions (
  original_transaction_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  transaction_id TEXT PRIMARY KEY,
  original_transaction_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  cap_usd_millis INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  refunded_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  cap_usd_millis INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lots (
  lot_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  source TEXT NOT NULL,
  transaction_id TEXT,
  original_cap_usd_millis INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apple_notifications (
  notification_uuid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  transaction_id TEXT,
  processed_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_refunds (
  transaction_id TEXT PRIMARY KEY,
  notification_uuid TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
  athlete_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  banned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS banned_original_transactions (
  original_transaction_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_provider_mutations (
  mutation_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
