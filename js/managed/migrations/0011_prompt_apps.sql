-- App documents and their JSON state are private to one account. Keeping state on
-- the same row makes deletion atomic and prevents orphaned data after races.
CREATE TABLE prompt_apps (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime = 'swift-v1'),
  source TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  previous_title TEXT,
  previous_description TEXT,
  previous_source TEXT,
  data_json TEXT NOT NULL DEFAULT 'null',
  data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
  data_updated_at TEXT,
  PRIMARY KEY (owner_id, id)
);
