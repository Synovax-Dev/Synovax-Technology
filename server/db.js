import { DatabaseSync } from 'node:sqlite';

// Everything a person writes is stored as ciphertext. What stays readable here
// is only what the server needs: ids, sizes, times, and who read what.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  salt             TEXT NOT NULL,
  kdf_iter         INTEGER NOT NULL,
  auth_hash        TEXT NOT NULL,
  rec_auth_hash    TEXT NOT NULL,
  wrapped_vk       TEXT NOT NULL,
  wrapped_vk_rec   TEXT NOT NULL,
  box_pub          TEXT NOT NULL,
  box_priv_wrapped TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  meta        TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  folder_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  head       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  meta         TEXT NOT NULL,
  auth_hash    TEXT NOT NULL,
  vouch        TEXT NOT NULL,
  can_suggest  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS app_folder_keys (
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (app_id, folder_id)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  app_id     TEXT,
  box        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- No foreign keys: the log outlives revoked apps. Leaf hashes are copied into
-- seal_leaves when sealed, so other vaults' proofs survive an account deletion.
CREATE TABLE IF NOT EXISTS read_log (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  id       TEXT NOT NULL UNIQUE,
  vault_id TEXT NOT NULL,
  app_id   TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  ts       INTEGER NOT NULL,
  salt     TEXT NOT NULL,
  leaf     TEXT NOT NULL,
  seal_seq INTEGER,
  leaf_idx INTEGER
);
CREATE TABLE IF NOT EXISTS seals (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start INTEGER NOT NULL UNIQUE,
  period_end   INTEGER NOT NULL,
  root         TEXT NOT NULL,
  count        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seal_leaves (
  seal_seq INTEGER NOT NULL,
  idx      INTEGER NOT NULL,
  leaf     TEXT NOT NULL,
  PRIMARY KEY (seal_seq, idx)
);
CREATE INDEX IF NOT EXISTS memories_vault ON memories(vault_id);
CREATE INDEX IF NOT EXISTS memories_folder ON memories(folder_id);
CREATE INDEX IF NOT EXISTS folders_vault ON folders(vault_id);
-- the admin panel: public token details (contract address, X account) and who changed what
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  ip    TEXT,
  field TEXT NOT NULL,
  old   TEXT,
  new   TEXT
);
-- the public hourly test of the hidden-instruction checks; each round commits to the one before
CREATE TABLE IF NOT EXISTS immune_rounds (
  hour_start INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  held       INTEGER NOT NULL,
  results    TEXT NOT NULL,
  prev       TEXT NOT NULL,
  hash       TEXT NOT NULL
);
-- a folder shared with another vault: its key, sealed for that vault (the server cannot open it),
-- and the owner's own note of who it went to, encrypted with the owner's vault key
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  folder_id    TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  box          TEXT NOT NULL,
  meta         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (folder_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id);
CREATE INDEX IF NOT EXISTS shares_recipient ON shares(recipient_id);
-- legacy: the vault key sealed for an heir, handed over only after the owner has
-- not opened the vault for wait_days (vaults.last_seen_at)
CREATE TABLE IF NOT EXISTS legacy (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  heir_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  box        TEXT NOT NULL,
  meta       TEXT NOT NULL,
  wait_days  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, heir_id)
);
CREATE INDEX IF NOT EXISTS legacy_heir ON legacy(heir_id);
-- adding a device by QR code: lives at most 5 minutes. The new device's public key
-- and the vault key sealed for it pass through; the secret in the QR code never does.
CREATE TABLE IF NOT EXISTS pairings (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  device_pub   TEXT,
  device_mac   TEXT,
  device_agent TEXT,
  ticket_hash  TEXT,
  box          TEXT,
  box_mac      TEXT,
  token        TEXT
);
-- rate limits live here, so a restart does not give a guesser a fresh start
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_hits_key ON rate_hits(key, ts);
CREATE INDEX IF NOT EXISTS rate_hits_ts ON rate_hits(ts);
CREATE INDEX IF NOT EXISTS apps_vault ON apps(vault_id);
CREATE INDEX IF NOT EXISTS suggestions_vault ON suggestions(vault_id);
CREATE INDEX IF NOT EXISTS log_vault ON read_log(vault_id, seq);
CREATE INDEX IF NOT EXISTS log_unsealed ON read_log(seal_seq, ts);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  // secure_delete: deleted rows are overwritten on disk, not just unlinked.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;');
  // One transaction for the whole schema: each statement on its own would wait
  // for its own disk flush, which made starting take seconds on some machines.
  tx(db, () => { db.exec(SCHEMA); migrate(db); });
  return db;
}

// Columns added after the first release. Older databases get them on start.
const ADDED_COLUMNS = [
  ['sessions', 'id', 'TEXT'],            // a public id for the session list (the token hash stays private)
  ['sessions', 'created_at', 'INTEGER'],
  ['sessions', 'last_used_at', 'INTEGER'],
  ['sessions', 'agent', 'TEXT'],         // a short device label, e.g. "Chrome on Windows"
  ['seals', 'prev', 'TEXT'],             // the chain hash of the seal before this one
  ['seals', 'chain', 'TEXT'],            // SHA-256 over prev + this seal, so history cannot be rewritten quietly
  ['vaults', 'totp_enc', 'TEXT'],        // two-step sign-in secret, encrypted with a key derived from server-secret
  ['vaults', 'totp_pending_enc', 'TEXT'],// a secret being set up, not yet confirmed with a code
  ['vaults', 'totp_last', 'INTEGER'],    // the last time step accepted, so a code cannot be used twice
  ['vaults', 'last_seen_at', 'INTEGER'], // when the owner last opened the vault, for legacy
];

function migrate(db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sessions_id ON sessions(id)');
  db.exec('CREATE INDEX IF NOT EXISTS sessions_vault ON sessions(vault_id)');
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
