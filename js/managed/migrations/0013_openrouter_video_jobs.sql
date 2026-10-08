-- Durable, account-owned receipts for OpenRouter video jobs. Agents never supply
-- provider job IDs; they name their own operation_id, so one account cannot read
-- or download another account's job, and a repeated submit never spends twice.
CREATE TABLE openrouter_video_jobs (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitting', 'submitted', 'rejected', 'outcome_unknown')),
  job_id TEXT,
  job_status TEXT,
  error TEXT,
  outputs INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, operation_id)
);
