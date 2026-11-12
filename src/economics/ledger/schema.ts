/**
 * Schema of the budget ledger. Version 1.
 *
 * The CHECK constraints encode the invariants the code relies on, so a bug that writes an impossible row fails at the
 * database, not later in a report:
 *   - a SETTLED reservation has a settled amount, and no other state does;
 *   - a RELEASED reservation carries the proof it was released on;
 *   - amounts are non-negative integers (micro-dollars).
 * usage_events is append-only: triggers refuse UPDATE and DELETE.
 */

export const LEDGER_SCHEMA_VERSION = 1;

export const LEDGER_SCHEMA_SQL = `
CREATE TABLE cycles (
  account_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  cap_micro INTEGER CHECK (cap_micro IS NULL OR cap_micro >= 0),
  overexposed INTEGER NOT NULL DEFAULT 0 CHECK (overexposed IN (0, 1)),
  overexposed_reason TEXT,
  purchased_baseline_micro INTEGER CHECK (purchased_baseline_micro IS NULL OR purchased_baseline_micro >= 0),
  PRIMARY KEY (account_id, cycle_id)
);

CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier = 'cloud'),
  price_version_id TEXT NOT NULL,
  bound_micro INTEGER NOT NULL CHECK (bound_micro >= 0),
  settled_micro INTEGER CHECK (settled_micro IS NULL OR settled_micro >= 0),
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNKNOWN_USAGE')),
  release_proof TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id, cycle_id) REFERENCES cycles (account_id, cycle_id),
  CHECK ((state = 'SETTLED') = (settled_micro IS NOT NULL)),
  CHECK (state <> 'RELEASED' OR release_proof IS NOT NULL)
);

CREATE INDEX reservations_account_state ON reservations (account_id, state);

CREATE TABLE usage_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL REFERENCES reservations (reservation_id),
  kind TEXT NOT NULL CHECK (kind IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNKNOWN', 'RECONCILED', 'OVEREXPOSED')),
  amount_micro INTEGER CHECK (amount_micro IS NULL OR amount_micro >= 0),
  detail TEXT,
  at TEXT NOT NULL
);

CREATE TRIGGER usage_events_no_update BEFORE UPDATE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only');
END;

CREATE TRIGGER usage_events_no_delete BEFORE DELETE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only');
END;
`;
