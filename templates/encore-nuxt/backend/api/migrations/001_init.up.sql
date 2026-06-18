CREATE TABLE IF NOT EXISTS app_bootstrap (
  id integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
