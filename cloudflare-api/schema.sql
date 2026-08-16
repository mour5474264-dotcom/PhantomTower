CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  license_key_hash TEXT NOT NULL UNIQUE,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  max_devices INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  device_hash TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(license_id, device_hash)
);

CREATE TABLE IF NOT EXISTS activation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  device_hash TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);
