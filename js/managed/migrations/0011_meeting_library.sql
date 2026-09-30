-- Native recordings are independent of CRM invitations and ephemeral previews.
CREATE TABLE meeting_library (
 owner_id TEXT NOT NULL, organization_id TEXT NOT NULL, team_id TEXT NOT NULL, id TEXT NOT NULL,
 title TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 duration_seconds INTEGER NOT NULL, transcript TEXT NOT NULL, notes TEXT NOT NULL,
 partial INTEGER NOT NULL CHECK(partial IN (0,1)), revision INTEGER NOT NULL CHECK(revision > 0),
 content_hash TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
 summary_status TEXT NOT NULL DEFAULT 'none' CHECK(summary_status IN ('none','ready','unavailable')),
 summary_revision INTEGER, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 PRIMARY KEY(owner_id,organization_id,team_id,id)
);
CREATE INDEX meeting_library_page ON meeting_library(owner_id,organization_id,team_id,deleted,started_at DESC,id DESC);
CREATE TABLE meeting_library_summary_budget (
 owner_id TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(owner_id,day)
);
