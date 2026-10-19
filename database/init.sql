-- LocalPass schema. The desktop runtime creates the same schema on first unlock.
-- Do not put real passwords or secrets in this file.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL,
  display_name TEXT NOT NULL,
  site_name TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL DEFAULT '',
  icon_data TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'web' CHECK (category IN ('web', 'app')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_apps_identity ON apps(identity);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  username TEXT,
  password_blob TEXT,
  iv TEXT,
  version_tag INTEGER NOT NULL DEFAULT 1,
  is_latest INTEGER NOT NULL DEFAULT 1,
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credentials_latest
  ON credentials(app_id, is_latest, version_tag DESC);

CREATE INDEX IF NOT EXISTS idx_credentials_history
  ON credentials(app_id, version_tag DESC);
