CREATE TABLE IF NOT EXISTS services (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS services_active_name_unique
  ON services (LOWER(name)) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS payment_modes (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_modes_active_name_unique
  ON payment_modes (LOWER(name)) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS entries (
  id BIGSERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  entry_time TIME NOT NULL,
  entry_year SMALLINT NOT NULL CHECK (entry_year IN (2026, 2027, 2028)),
  entry_month SMALLINT NOT NULL CHECK (entry_month BETWEEN 1 AND 12),
  client_name VARCHAR(120) NOT NULL,
  client_search VARCHAR(120) NOT NULL,
  service_name VARCHAR(100) NOT NULL,
  payment_name VARCHAR(80) NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS entries_day_idx
  ON entries (entry_date, entry_time DESC);
CREATE INDEX IF NOT EXISTS entries_archive_idx
  ON entries (entry_year, entry_month, entry_date DESC, entry_time DESC);
CREATE INDEX IF NOT EXISTS entries_client_idx
  ON entries (entry_year, client_search, entry_date DESC, entry_time DESC);
