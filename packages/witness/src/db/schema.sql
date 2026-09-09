-- KLAXON witness schema (A §5.1, with D28 applied: `shares` has no `b_enc` column — share B is
-- derived from WITNESS_MASTER on demand and never stored).

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  project_id     TEXT PRIMARY KEY,              -- 64 hex
  repository     TEXT NOT NULL,                 -- "org/repo", for raw.githubusercontent fetches
  repository_id  TEXT NOT NULL,                 -- GitHub numeric id, as a string
  -- Recorded provenance only: which trustchain member the project's share A is bound to. It
  -- deliberately authorises nothing, because this key is shipped to every runner (see below).
  member_pubkey  TEXT NOT NULL,
  -- Authorises /shares, /rotate, /revoke, /unrevoke. D27 originally used member_pubkey for this;
  -- that made POST /shares a free share-B oracle for anything sharing a job's environment, since
  -- the member credential is a required input of klaxon/get. The operator key never leaves the
  -- laptop.
  operator_pubkey TEXT NOT NULL DEFAULT '',
  -- Hedera account registered as this project's payer; check 1 binds the debit to it (null = the
  -- binding is not enforced, for projects registered before it existed).
  pay_account    TEXT,
  owner_address  TEXT,                          -- Sepolia owner, mirrored
  topic_id       TEXT NOT NULL,
  ntfy_topic     TEXT,                          -- klaxon-<32 hex>; the name is the password (D29)
  policy_hash    TEXT,                          -- 64 hex, mirrored from Sepolia
  policy_block   INTEGER,
  current_gen    INTEGER NOT NULL DEFAULT 1,
  max_releases   INTEGER NOT NULL DEFAULT 50,
  revoked        INTEGER NOT NULL DEFAULT 0,
  local_epoch    INTEGER NOT NULL DEFAULT 0,
  chain_epoch    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

-- No `b_enc`: B = HKDF(WITNESS_MASTER, "klaxon/b/v1", project_id/secret/gen) (PROTOCOL §3, D28).
CREATE TABLE IF NOT EXISTS shares (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  secret     TEXT NOT NULL,
  gen        INTEGER NOT NULL,
  b_hash     TEXT NOT NULL,                     -- 64 hex, what the runner checks B against
  retired    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, secret, gen)         -- first write wins
);

CREATE TABLE IF NOT EXISTS releases (
  h               TEXT PRIMARY KEY,             -- check 9: replay protection
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  secret          TEXT NOT NULL,
  gen             INTEGER NOT NULL,
  environment     TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  run_attempt     TEXT NOT NULL,
  commitment_json TEXT NOT NULL,                -- canonical C (carries ephemeral_pub)
  jwt             TEXT NOT NULL,
  sig             TEXT NOT NULL,
  pay_tx          TEXT NOT NULL,
  outbox_id       INTEGER,
  hcs_seq         TEXT,
  hcs_consensus   TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_releases_paytx ON releases(pay_tx);
CREATE INDEX IF NOT EXISTS ix_releases_budget ON releases(project_id, secret, gen);

CREATE TABLE IF NOT EXISTS refusals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  h               TEXT NOT NULL,
  project_id      TEXT,
  class           TEXT NOT NULL CHECK (class IN ('auth','policy','infra')),
  check_id        INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  commitment_json TEXT,
  jwt             TEXT,
  pay_tx          TEXT,
  hcs_seq         TEXT,
  hcs_consensus   TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_refusals_h ON refusals(h);
CREATE INDEX IF NOT EXISTS ix_refusals_paytx ON refusals(pay_tx);

CREATE TABLE IF NOT EXISTS revocation (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  revoked_at TEXT NOT NULL,
  reason     TEXT NOT NULL,
  h          TEXT,
  epoch      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jwks_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at    TEXT NOT NULL,
  jwks_json     TEXT NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,           -- dedupe identical daily snapshots
  hcs_seq       TEXT,
  hcs_consensus TEXT
);

-- The difference between a demo that survives a restart and one that does not (A §5.1): the
-- decision and the intent to publish are one atomic write, and the drain job retries.
CREATE TABLE IF NOT EXISTS hcs_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- released|refused|rotate|revoke|unrevoke|jwks
  state      TEXT NOT NULL DEFAULT 'pending',   -- pending|sent|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  seq        TEXT,
  consensus  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON hcs_outbox(state, id);

-- Restart-safe Sepolia cursor (D8) and anything else that is a single scalar.
CREATE TABLE IF NOT EXISTS cursor (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A commit sha is immutable, so this cache never needs invalidation (B §5.3).
CREATE TABLE IF NOT EXISTS workflow_cache (
  repository TEXT NOT NULL,
  sha        TEXT NOT NULL,
  path       TEXT NOT NULL,
  content    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repository, sha, path)
);
