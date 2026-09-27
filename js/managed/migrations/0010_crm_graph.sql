-- Native knowledge is untyped text with arbitrary JSON-object metadata. Legacy
-- tables remain authoritative for their source projections; API writes must guard
-- the reserved legacy: namespace and crm_legacy_links. SQL triggers deliberately
-- do not block legacy integrations. JSON column values are preserved as original
-- strings inside metadata.legacy, together with every other original column.
-- occurred_at retains source date precision; occurred_at_basis distinguishes
-- effective dates, scheduled/contextual dates, and received email timestamps.
-- Inherited scheduled dates never establish attendance. Unknown dates stay absent.
CREATE TABLE crm_nodes (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
 metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata) AND json_type(metadata)='object'),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX crm_nodes_page ON crm_nodes(owner_id,created_at,id);
CREATE TABLE crm_links (
 owner_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,from_id,to_id), CHECK(from_id < to_id),
 FOREIGN KEY(owner_id,from_id) REFERENCES crm_nodes(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,to_id) REFERENCES crm_nodes(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_links_to ON crm_links(owner_id,to_id,from_id);

CREATE VIEW crm_graph_crm_records AS
SELECT s.owner_id, 'legacy:crm_records:' || json_array(s.id) AS id, s.name AS text,
 json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'kind', s.kind, 'name', s.name, 'email', s.email, 'phone', s.phone, 'website', s.website, 'title', s.title, 'company_id', s.company_id, 'tags', s.tags, 'created_at', s.created_at, 'updated_at', s.updated_at)) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_records s;

CREATE VIEW crm_graph_crm_notes AS
SELECT s.owner_id, 'legacy:crm_notes:' || json_array(s.id) AS id, s.body AS text,
 json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'record_id', s.record_id, 'body', s.body, 'source_url', s.source_url, 'created_at', s.created_at, 'updated_at', s.updated_at)) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_notes s;

CREATE VIEW crm_graph_crm_facts AS
SELECT s.owner_id, 'legacy:crm_facts:' || json_array(s.id) AS id, s.predicate || ': ' || s.value_json AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'record_id', s.record_id, 'predicate', s.predicate, 'value_json', s.value_json, 'origin', s.origin, 'sources', s.sources, 'confidence', s.confidence, 'rationale', s.rationale, 'effective_from', s.effective_from, 'effective_to', s.effective_to, 'state', s.state, 'created_at', s.created_at, 'updated_at', s.updated_at)), CASE WHEN s.effective_from IS NOT NULL THEN json_object('occurred_at', s.effective_from, 'occurred_at_basis', 'effective_from') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_facts s;

CREATE VIEW crm_graph_crm_identities AS
SELECT s.owner_id, 'legacy:crm_identities:' || json_array(s.id) AS id, s.kind || ': ' || s.value AS text,
 json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'record_id', s.record_id, 'kind', s.kind, 'value', s.value, 'normalized', s.normalized, 'origin', s.origin, 'source_ref', s.source_ref, 'created_at', s.created_at, 'updated_at', s.updated_at)) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_identities s;

CREATE VIEW crm_graph_crm_research AS
SELECT s.owner_id, 'legacy:crm_research:' || json_array(s.record_id) AS id, s.summary AS text,
 json_object('legacy', json_object('owner_id', s.owner_id, 'record_id', s.record_id, 'summary', s.summary, 'company', s.company, 'title', s.title, 'website', s.website, 'sources', s.sources, 'status', s.status, 'checked_at', s.checked_at)) AS metadata,
 s.checked_at AS created_at, s.checked_at AS updated_at
FROM crm_research s;

-- Explicit descriptions take precedence over legacy catchall relationship types.
CREATE VIEW crm_graph_crm_relationships AS
SELECT s.owner_id, 'legacy:crm_relationships:' || json_array(s.id) AS id, json_quote(coalesce((SELECT p.name FROM crm_records p WHERE p.owner_id=s.owner_id AND p.id=s.from_id), s.from_id))
 || ' → ' || json_quote(coalesce((SELECT p.name FROM crm_records p WHERE p.owner_id=s.owner_id AND p.id=s.to_id), s.to_id))
 || ': ' || coalesce(s.description, replace(s.type, '_', ' ')) || coalesce(' (role: ' || s.role || ')', '') AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'from_id', s.from_id, 'to_id', s.to_id, 'type', s.type, 'role', s.role, 'description', s.description, 'origin', s.origin, 'sources', s.sources, 'confidence', s.confidence, 'rationale', s.rationale, 'effective_from', s.effective_from, 'effective_to', s.effective_to, 'created_at', s.created_at, 'updated_at', s.updated_at)), CASE WHEN s.effective_from IS NOT NULL THEN json_object('occurred_at', s.effective_from, 'occurred_at_basis', 'effective_from') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_relationships s;

CREATE VIEW crm_graph_crm_events AS
SELECT s.owner_id, 'legacy:crm_events:' || json_array(s.id) AS id, s.title AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'title', s.title, 'description', s.description, 'location', s.location, 'start_at', s.start_at, 'start_ms', s.start_ms, 'end_at', s.end_at, 'end_ms', s.end_ms, 'origin', s.origin, 'sources', s.sources, 'confidence', s.confidence, 'rationale', s.rationale, 'created_at', s.created_at, 'updated_at', s.updated_at, 'start_precision', s.start_precision, 'end_precision', s.end_precision, 'metadata', s.metadata)), CASE WHEN s.start_at IS NOT NULL THEN json_object('occurred_at', s.start_at, 'occurred_at_basis', 'event_start') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_events s;

CREATE VIEW crm_graph_crm_event_participation AS
SELECT s.owner_id, 'legacy:crm_event_participation:' || json_array(s.id) AS id, 'Record ' || json_quote(s.record_id) || ': ' || s.status || ' as ' || s.role || ' at event ' || json_quote(s.event_id) AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'event_id', s.event_id, 'record_id', s.record_id, 'person_id', s.person_id, 'status', s.status, 'role', s.role, 'metadata', s.metadata, 'origin', s.origin, 'sources', s.sources, 'confidence', s.confidence, 'rationale', s.rationale, 'created_at', s.created_at, 'updated_at', s.updated_at)), CASE WHEN (SELECT p.start_at FROM crm_events p WHERE p.owner_id=s.owner_id AND p.id=s.event_id) IS NOT NULL THEN json_object('occurred_at', (SELECT p.start_at FROM crm_events p WHERE p.owner_id=s.owner_id AND p.id=s.event_id), 'occurred_at_basis', 'event_start') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_event_participation s;

CREATE VIEW crm_graph_crm_interactions AS
SELECT s.owner_id, 'legacy:crm_interactions:' || json_array(s.id) AS id, s.body AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'person_id', s.person_id, 'type', s.type, 'summary', s.summary, 'precision', s.precision, 'event_id', s.event_id, 'meeting_id', s.meeting_id, 'connection_id', s.connection_id, 'message_id', s.message_id, 'occurred_at', s.occurred_at, 'occurred_ms', s.occurred_ms, 'body', s.body, 'origin', s.origin, 'sources', s.sources, 'confidence', s.confidence, 'rationale', s.rationale, 'created_at', s.created_at, 'updated_at', s.updated_at, 'occurred_precision', s.occurred_precision, 'metadata', s.metadata)), CASE WHEN s.occurred_at IS NOT NULL THEN json_object('occurred_at', s.occurred_at, 'occurred_at_basis', 'interaction_occurrence') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_interactions s;

CREATE VIEW crm_graph_crm_interaction_participants AS
SELECT s.owner_id, 'legacy:crm_interaction_participants:' || json_array(s.interaction_id, s.record_id) AS id, 'Record ' || json_quote(s.record_id) || ' participates in interaction ' || json_quote(s.interaction_id) || coalesce(' as ' || s.role, '') AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'interaction_id', s.interaction_id, 'record_id', s.record_id, 'role', s.role)), CASE WHEN (SELECT p.occurred_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) IS NOT NULL THEN json_object('occurred_at', (SELECT p.occurred_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id), 'occurred_at_basis', 'interaction_occurrence') ELSE '{}' END) AS metadata,
 (SELECT p.created_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) AS created_at, (SELECT p.updated_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) AS updated_at
FROM crm_interaction_participants s;

CREATE VIEW crm_graph_crm_meetings AS
SELECT s.owner_id, 'legacy:crm_meetings:' || json_array(s.id) AS id, s.title AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'connection_id', s.connection_id, 'calendar_id', s.calendar_id, 'event_id', s.event_id, 'title', s.title, 'description', s.description, 'location', s.location, 'html_link', s.html_link, 'start_time', s.start_time, 'end_time', s.end_time, 'start_ms', s.start_ms, 'end_ms', s.end_ms, 'all_day', s.all_day, 'organizer', s.organizer, 'status', s.status, 'eligible', s.eligible, 'self_declined', s.self_declined, 'attendees_complete', s.attendees_complete, 'source_updated', s.source_updated, 'source_revision', s.source_revision, 'import_token', s.import_token, 'skipped', s.skipped, 'skip_reason', s.skip_reason, 'created_at', s.created_at, 'updated_at', s.updated_at)), CASE WHEN s.start_time IS NOT NULL THEN json_object('occurred_at', s.start_time, 'occurred_at_basis', 'scheduled_meeting_start') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_meetings s;

CREATE VIEW crm_graph_crm_meeting_attendees AS
SELECT s.owner_id, 'legacy:crm_meeting_attendees:' || json_array(s.meeting_id, s.ordinal) AS id, coalesce(s.name, s.email, 'Attendee ' || s.ordinal) || coalesce(': ' || s.response_status, '') AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'meeting_id', s.meeting_id, 'ordinal', s.ordinal, 'email', s.email, 'name', s.name, 'response_status', s.response_status, 'person_id', s.person_id)), CASE WHEN (SELECT p.start_time FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) IS NOT NULL THEN json_object('occurred_at', (SELECT p.start_time FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id), 'occurred_at_basis', 'scheduled_meeting_start') ELSE '{}' END) AS metadata,
 (SELECT p.created_at FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) AS created_at, (SELECT p.updated_at FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) AS updated_at
FROM crm_meeting_attendees s;

CREATE VIEW crm_graph_crm_meeting_notes AS
SELECT s.owner_id, 'legacy:crm_meeting_notes:' || json_array(s.id) AS id, s.body AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'id', s.id, 'meeting_id', s.meeting_id, 'body', s.body, 'created_at', s.created_at, 'updated_at', s.updated_at)), CASE WHEN (SELECT p.start_time FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) IS NOT NULL THEN json_object('occurred_at', (SELECT p.start_time FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id), 'occurred_at_basis', 'scheduled_meeting_start') ELSE '{}' END) AS metadata,
 s.created_at AS created_at, s.updated_at AS updated_at
FROM crm_meeting_notes s;

CREATE VIEW crm_graph_crm_email_imports AS
SELECT s.owner_id, 'legacy:crm_email_imports:' || json_array(s.connection_id, s.message_id) AS id, 'Email ' || json_quote(s.message_id) || ' on connection ' || json_quote(s.connection_id) AS text,
 json_patch(json_object('legacy', json_object('owner_id', s.owner_id, 'connection_id', s.connection_id, 'message_id', s.message_id, 'record_id', s.record_id, 'note_id', s.note_id, 'imported_at', s.imported_at, 'received_ms', s.received_ms)), CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ',s.received_ms / 1000.0,'unixepoch') IS NOT NULL THEN json_object('occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ',s.received_ms / 1000.0,'unixepoch'), 'occurred_at_basis', 'email_received') ELSE '{}' END) AS metadata,
 s.imported_at AS created_at, s.imported_at AS updated_at
FROM crm_email_imports s;

-- Nested groups stay within D1 compound-SELECT limits.

CREATE VIEW crm_legacy_nodes AS
SELECT * FROM (SELECT * FROM crm_graph_crm_records
UNION ALL
SELECT * FROM crm_graph_crm_notes
UNION ALL
SELECT * FROM crm_graph_crm_facts
UNION ALL
SELECT * FROM crm_graph_crm_identities)
UNION ALL
SELECT * FROM (SELECT * FROM crm_graph_crm_research
UNION ALL
SELECT * FROM crm_graph_crm_relationships
UNION ALL
SELECT * FROM crm_graph_crm_events
UNION ALL
SELECT * FROM crm_graph_crm_event_participation)
UNION ALL
SELECT * FROM (SELECT * FROM crm_graph_crm_interactions
UNION ALL
SELECT * FROM crm_graph_crm_interaction_participants
UNION ALL
SELECT * FROM crm_graph_crm_meetings
UNION ALL
SELECT * FROM crm_graph_crm_meeting_attendees)
UNION ALL
SELECT * FROM (SELECT * FROM crm_graph_crm_meeting_notes
UNION ALL
SELECT * FROM crm_graph_crm_email_imports);

-- Each contextual assertion links to its endpoints; direction, roles and source
-- semantics live in assertion text/metadata, never in native link columns.
CREATE VIEW crm_graph_source_links AS
SELECT l.owner_id,l.source_id,min(l.source_id,l.target_id) AS from_id,
 max(l.source_id,l.target_id) AS to_id,l.created_at,l.updated_at
FROM (
SELECT * FROM (SELECT * FROM (SELECT s.owner_id, 'legacy:crm_records:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.company_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_records s
UNION ALL
SELECT s.owner_id, 'legacy:crm_notes:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_notes s
UNION ALL
SELECT s.owner_id, 'legacy:crm_facts:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_facts s
UNION ALL
SELECT s.owner_id, 'legacy:crm_identities:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_identities s)
UNION ALL
SELECT * FROM (SELECT s.owner_id, 'legacy:crm_research:' || json_array(s.record_id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, s.checked_at AS created_at, s.checked_at AS updated_at FROM crm_research s
UNION ALL
SELECT s.owner_id, 'legacy:crm_relationships:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.from_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_relationships s
UNION ALL
SELECT s.owner_id, 'legacy:crm_relationships:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.to_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_relationships s
UNION ALL
SELECT s.owner_id, 'legacy:crm_event_participation:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_event_participation s)
UNION ALL
SELECT * FROM (SELECT s.owner_id, 'legacy:crm_event_participation:' || json_array(s.id) AS source_id, 'legacy:crm_events:' || json_array(s.event_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_event_participation s
UNION ALL
SELECT s.owner_id, 'legacy:crm_interactions:' || json_array(s.id) AS source_id, 'legacy:crm_records:' || json_array(s.person_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_interactions s
UNION ALL
SELECT s.owner_id, 'legacy:crm_interactions:' || json_array(s.id) AS source_id, 'legacy:crm_events:' || json_array(s.event_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_interactions s
UNION ALL
SELECT s.owner_id, 'legacy:crm_interactions:' || json_array(s.id) AS source_id, 'legacy:crm_meetings:' || json_array(s.meeting_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_interactions s)
UNION ALL
SELECT * FROM (SELECT s.owner_id, 'legacy:crm_interactions:' || json_array(s.id) AS source_id, 'legacy:crm_email_imports:' || json_array(s.connection_id, s.message_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_interactions s
UNION ALL
SELECT s.owner_id, 'legacy:crm_interaction_participants:' || json_array(s.interaction_id, s.record_id) AS source_id, 'legacy:crm_interactions:' || json_array(s.interaction_id) AS target_id, (SELECT p.created_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) AS created_at, (SELECT p.updated_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) AS updated_at FROM crm_interaction_participants s
UNION ALL
SELECT s.owner_id, 'legacy:crm_interaction_participants:' || json_array(s.interaction_id, s.record_id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, (SELECT p.created_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) AS created_at, (SELECT p.updated_at FROM crm_interactions p WHERE p.owner_id=s.owner_id AND p.id=s.interaction_id) AS updated_at FROM crm_interaction_participants s
UNION ALL
SELECT s.owner_id, 'legacy:crm_meeting_attendees:' || json_array(s.meeting_id, s.ordinal) AS source_id, 'legacy:crm_meetings:' || json_array(s.meeting_id) AS target_id, (SELECT p.created_at FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) AS created_at, (SELECT p.updated_at FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) AS updated_at FROM crm_meeting_attendees s))
UNION ALL
SELECT * FROM (SELECT * FROM (SELECT s.owner_id, 'legacy:crm_meeting_attendees:' || json_array(s.meeting_id, s.ordinal) AS source_id, 'legacy:crm_records:' || json_array(s.person_id) AS target_id, (SELECT p.created_at FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) AS created_at, (SELECT p.updated_at FROM crm_meetings p WHERE p.owner_id=s.owner_id AND p.id=s.meeting_id) AS updated_at FROM crm_meeting_attendees s
UNION ALL
SELECT s.owner_id, 'legacy:crm_meeting_notes:' || json_array(s.id) AS source_id, 'legacy:crm_meetings:' || json_array(s.meeting_id) AS target_id, s.created_at AS created_at, s.updated_at AS updated_at FROM crm_meeting_notes s
UNION ALL
SELECT s.owner_id, 'legacy:crm_email_imports:' || json_array(s.connection_id, s.message_id) AS source_id, 'legacy:crm_records:' || json_array(s.record_id) AS target_id, s.imported_at AS created_at, s.imported_at AS updated_at FROM crm_email_imports s
UNION ALL
SELECT s.owner_id, 'legacy:crm_email_imports:' || json_array(s.connection_id, s.message_id) AS source_id, 'legacy:crm_notes:' || json_array(s.note_id) AS target_id, s.imported_at AS created_at, s.imported_at AS updated_at FROM crm_email_imports s))
) l JOIN crm_nodes a ON a.owner_id=l.owner_id AND a.id=l.source_id
 JOIN crm_nodes b ON b.owner_id=l.owner_id AND b.id=l.target_id
WHERE l.source_id != l.target_id;
CREATE VIEW crm_legacy_links AS
SELECT owner_id,from_id,to_id,min(created_at) AS created_at,max(updated_at) AS updated_at
FROM crm_graph_source_links GROUP BY owner_id,from_id,to_id;
INSERT INTO crm_nodes SELECT * FROM crm_legacy_nodes;
INSERT INTO crm_links SELECT * FROM crm_legacy_links;

-- Refresh only source-owned links. Independently added native links survive.
-- Explicit UPSERT conflict clauses are required here: an outer legacy UPSERT
-- overrides INSERT OR IGNORE within triggers.
CREATE TRIGGER crm_graph_crm_records_before_update BEFORE UPDATE ON crm_records
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_records:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_records_delete AFTER DELETE ON crm_records
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_records:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_records_insert AFTER INSERT ON crm_records
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_records WHERE owner_id=NEW.owner_id AND id='legacy:crm_records:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_records:' || json_array(NEW.id) OR from_id='legacy:crm_records:' || json_array(NEW.id) OR to_id='legacy:crm_records:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_records_update AFTER UPDATE ON crm_records
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_records:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_records:' || json_array(OLD.id)) != ('legacy:crm_records:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_records WHERE owner_id=NEW.owner_id AND id='legacy:crm_records:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_records:' || json_array(NEW.id) OR from_id='legacy:crm_records:' || json_array(NEW.id) OR to_id='legacy:crm_records:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

 -- Names are display context, not a new relationship assertion. Refresh without
 -- replacing assertion nodes or disturbing native links attached to them.
 INSERT INTO crm_nodes SELECT v.* FROM crm_graph_crm_relationships v
 WHERE v.owner_id=NEW.owner_id AND v.id IN
  (SELECT 'legacy:crm_relationships:' || json_array(r.id) FROM crm_relationships r
   WHERE r.owner_id=NEW.owner_id AND (r.from_id=NEW.id OR r.to_id=NEW.id))
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text;

END;

CREATE TRIGGER crm_graph_crm_notes_before_update BEFORE UPDATE ON crm_notes
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_notes:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_notes_delete AFTER DELETE ON crm_notes
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_notes:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_notes_insert AFTER INSERT ON crm_notes
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_notes WHERE owner_id=NEW.owner_id AND id='legacy:crm_notes:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_notes:' || json_array(NEW.id) OR from_id='legacy:crm_notes:' || json_array(NEW.id) OR to_id='legacy:crm_notes:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_notes_update AFTER UPDATE ON crm_notes
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_notes:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_notes:' || json_array(OLD.id)) != ('legacy:crm_notes:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_notes WHERE owner_id=NEW.owner_id AND id='legacy:crm_notes:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_notes:' || json_array(NEW.id) OR from_id='legacy:crm_notes:' || json_array(NEW.id) OR to_id='legacy:crm_notes:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_facts_before_update BEFORE UPDATE ON crm_facts
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_facts:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_facts_delete AFTER DELETE ON crm_facts
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_facts:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_facts_insert AFTER INSERT ON crm_facts
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_facts WHERE owner_id=NEW.owner_id AND id='legacy:crm_facts:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_facts:' || json_array(NEW.id) OR from_id='legacy:crm_facts:' || json_array(NEW.id) OR to_id='legacy:crm_facts:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_facts_update AFTER UPDATE ON crm_facts
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_facts:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_facts:' || json_array(OLD.id)) != ('legacy:crm_facts:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_facts WHERE owner_id=NEW.owner_id AND id='legacy:crm_facts:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_facts:' || json_array(NEW.id) OR from_id='legacy:crm_facts:' || json_array(NEW.id) OR to_id='legacy:crm_facts:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_identities_before_update BEFORE UPDATE ON crm_identities
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_identities:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_identities_delete AFTER DELETE ON crm_identities
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_identities:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_identities_insert AFTER INSERT ON crm_identities
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_identities WHERE owner_id=NEW.owner_id AND id='legacy:crm_identities:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_identities:' || json_array(NEW.id) OR from_id='legacy:crm_identities:' || json_array(NEW.id) OR to_id='legacy:crm_identities:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_identities_update AFTER UPDATE ON crm_identities
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_identities:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_identities:' || json_array(OLD.id)) != ('legacy:crm_identities:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_identities WHERE owner_id=NEW.owner_id AND id='legacy:crm_identities:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_identities:' || json_array(NEW.id) OR from_id='legacy:crm_identities:' || json_array(NEW.id) OR to_id='legacy:crm_identities:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_research_before_update BEFORE UPDATE ON crm_research
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_research:' || json_array(OLD.record_id));
END;
CREATE TRIGGER crm_graph_crm_research_delete AFTER DELETE ON crm_research
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_research:' || json_array(OLD.record_id);
END;

CREATE TRIGGER crm_graph_crm_research_insert AFTER INSERT ON crm_research
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_research WHERE owner_id=NEW.owner_id AND id='legacy:crm_research:' || json_array(NEW.record_id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_research:' || json_array(NEW.record_id) OR from_id='legacy:crm_research:' || json_array(NEW.record_id) OR to_id='legacy:crm_research:' || json_array(NEW.record_id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_research_update AFTER UPDATE ON crm_research
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_research:' || json_array(OLD.record_id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_research:' || json_array(OLD.record_id)) != ('legacy:crm_research:' || json_array(NEW.record_id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_research WHERE owner_id=NEW.owner_id AND id='legacy:crm_research:' || json_array(NEW.record_id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_research:' || json_array(NEW.record_id) OR from_id='legacy:crm_research:' || json_array(NEW.record_id) OR to_id='legacy:crm_research:' || json_array(NEW.record_id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_relationships_before_update BEFORE UPDATE ON crm_relationships
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_relationships:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_relationships_delete AFTER DELETE ON crm_relationships
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_relationships:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_relationships_insert AFTER INSERT ON crm_relationships
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_relationships WHERE owner_id=NEW.owner_id AND id='legacy:crm_relationships:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_relationships:' || json_array(NEW.id) OR from_id='legacy:crm_relationships:' || json_array(NEW.id) OR to_id='legacy:crm_relationships:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_relationships_update AFTER UPDATE ON crm_relationships
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_relationships:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_relationships:' || json_array(OLD.id)) != ('legacy:crm_relationships:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_relationships WHERE owner_id=NEW.owner_id AND id='legacy:crm_relationships:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_relationships:' || json_array(NEW.id) OR from_id='legacy:crm_relationships:' || json_array(NEW.id) OR to_id='legacy:crm_relationships:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_events_before_update BEFORE UPDATE ON crm_events
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_events:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_events_delete AFTER DELETE ON crm_events
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_events:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_events_insert AFTER INSERT ON crm_events
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_events WHERE owner_id=NEW.owner_id AND id='legacy:crm_events:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_events:' || json_array(NEW.id) OR from_id='legacy:crm_events:' || json_array(NEW.id) OR to_id='legacy:crm_events:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_events_update AFTER UPDATE ON crm_events
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_events:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_events:' || json_array(OLD.id)) != ('legacy:crm_events:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_events WHERE owner_id=NEW.owner_id AND id='legacy:crm_events:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_events:' || json_array(NEW.id) OR from_id='legacy:crm_events:' || json_array(NEW.id) OR to_id='legacy:crm_events:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;
 INSERT INTO crm_nodes SELECT v.* FROM crm_graph_crm_event_participation v
 WHERE v.owner_id=NEW.owner_id AND v.id IN (SELECT 'legacy:crm_event_participation:' || json_array(s.id) FROM crm_event_participation s WHERE s.owner_id=NEW.owner_id AND s.event_id=NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET metadata=excluded.metadata,created_at=excluded.created_at,updated_at=excluded.updated_at;

END;

CREATE TRIGGER crm_graph_crm_event_participation_before_update BEFORE UPDATE ON crm_event_participation
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_event_participation:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_event_participation_delete AFTER DELETE ON crm_event_participation
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_event_participation:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_event_participation_insert AFTER INSERT ON crm_event_participation
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_event_participation WHERE owner_id=NEW.owner_id AND id='legacy:crm_event_participation:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_event_participation:' || json_array(NEW.id) OR from_id='legacy:crm_event_participation:' || json_array(NEW.id) OR to_id='legacy:crm_event_participation:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_event_participation_update AFTER UPDATE ON crm_event_participation
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_event_participation:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_event_participation:' || json_array(OLD.id)) != ('legacy:crm_event_participation:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_event_participation WHERE owner_id=NEW.owner_id AND id='legacy:crm_event_participation:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_event_participation:' || json_array(NEW.id) OR from_id='legacy:crm_event_participation:' || json_array(NEW.id) OR to_id='legacy:crm_event_participation:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_interactions_before_update BEFORE UPDATE ON crm_interactions
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_interactions:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_interactions_delete AFTER DELETE ON crm_interactions
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_interactions:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_interactions_insert AFTER INSERT ON crm_interactions
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_interactions WHERE owner_id=NEW.owner_id AND id='legacy:crm_interactions:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_interactions:' || json_array(NEW.id) OR from_id='legacy:crm_interactions:' || json_array(NEW.id) OR to_id='legacy:crm_interactions:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_interactions_update AFTER UPDATE ON crm_interactions
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_interactions:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_interactions:' || json_array(OLD.id)) != ('legacy:crm_interactions:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_interactions WHERE owner_id=NEW.owner_id AND id='legacy:crm_interactions:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_interactions:' || json_array(NEW.id) OR from_id='legacy:crm_interactions:' || json_array(NEW.id) OR to_id='legacy:crm_interactions:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;
 INSERT INTO crm_nodes SELECT v.* FROM crm_graph_crm_interaction_participants v
 WHERE v.owner_id=NEW.owner_id AND v.id IN (SELECT 'legacy:crm_interaction_participants:' || json_array(s.interaction_id, s.record_id) FROM crm_interaction_participants s WHERE s.owner_id=NEW.owner_id AND s.interaction_id=NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET metadata=excluded.metadata,created_at=excluded.created_at,updated_at=excluded.updated_at;

END;

CREATE TRIGGER crm_graph_crm_interaction_participants_before_update BEFORE UPDATE ON crm_interaction_participants
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_interaction_participants:' || json_array(OLD.interaction_id, OLD.record_id));
END;
CREATE TRIGGER crm_graph_crm_interaction_participants_delete AFTER DELETE ON crm_interaction_participants
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_interaction_participants:' || json_array(OLD.interaction_id, OLD.record_id);
END;

CREATE TRIGGER crm_graph_crm_interaction_participants_insert AFTER INSERT ON crm_interaction_participants
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_interaction_participants WHERE owner_id=NEW.owner_id AND id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id) OR from_id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id) OR to_id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_interaction_participants_update AFTER UPDATE ON crm_interaction_participants
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_interaction_participants:' || json_array(OLD.interaction_id, OLD.record_id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_interaction_participants:' || json_array(OLD.interaction_id, OLD.record_id)) != ('legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_interaction_participants WHERE owner_id=NEW.owner_id AND id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id) OR from_id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id) OR to_id='legacy:crm_interaction_participants:' || json_array(NEW.interaction_id, NEW.record_id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_meetings_before_update BEFORE UPDATE ON crm_meetings
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_meetings:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_meetings_delete AFTER DELETE ON crm_meetings
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_meetings:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_meetings_insert AFTER INSERT ON crm_meetings
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_meetings WHERE owner_id=NEW.owner_id AND id='legacy:crm_meetings:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_meetings:' || json_array(NEW.id) OR from_id='legacy:crm_meetings:' || json_array(NEW.id) OR to_id='legacy:crm_meetings:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_meetings_update AFTER UPDATE ON crm_meetings
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_meetings:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_meetings:' || json_array(OLD.id)) != ('legacy:crm_meetings:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_meetings WHERE owner_id=NEW.owner_id AND id='legacy:crm_meetings:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_meetings:' || json_array(NEW.id) OR from_id='legacy:crm_meetings:' || json_array(NEW.id) OR to_id='legacy:crm_meetings:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;
 INSERT INTO crm_nodes SELECT v.* FROM crm_graph_crm_meeting_attendees v
 WHERE v.owner_id=NEW.owner_id AND v.id IN (SELECT 'legacy:crm_meeting_attendees:' || json_array(s.meeting_id, s.ordinal) FROM crm_meeting_attendees s WHERE s.owner_id=NEW.owner_id AND s.meeting_id=NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET metadata=excluded.metadata,created_at=excluded.created_at,updated_at=excluded.updated_at;
INSERT INTO crm_nodes SELECT v.* FROM crm_graph_crm_meeting_notes v
 WHERE v.owner_id=NEW.owner_id AND v.id IN (SELECT 'legacy:crm_meeting_notes:' || json_array(s.id) FROM crm_meeting_notes s WHERE s.owner_id=NEW.owner_id AND s.meeting_id=NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET metadata=excluded.metadata,created_at=excluded.created_at,updated_at=excluded.updated_at;

END;

CREATE TRIGGER crm_graph_crm_meeting_attendees_before_update BEFORE UPDATE ON crm_meeting_attendees
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_meeting_attendees:' || json_array(OLD.meeting_id, OLD.ordinal));
END;
CREATE TRIGGER crm_graph_crm_meeting_attendees_delete AFTER DELETE ON crm_meeting_attendees
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_meeting_attendees:' || json_array(OLD.meeting_id, OLD.ordinal);
END;

CREATE TRIGGER crm_graph_crm_meeting_attendees_insert AFTER INSERT ON crm_meeting_attendees
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_meeting_attendees WHERE owner_id=NEW.owner_id AND id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal) OR from_id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal) OR to_id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_meeting_attendees_update AFTER UPDATE ON crm_meeting_attendees
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_meeting_attendees:' || json_array(OLD.meeting_id, OLD.ordinal) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_meeting_attendees:' || json_array(OLD.meeting_id, OLD.ordinal)) != ('legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_meeting_attendees WHERE owner_id=NEW.owner_id AND id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal) OR from_id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal) OR to_id='legacy:crm_meeting_attendees:' || json_array(NEW.meeting_id, NEW.ordinal))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_meeting_notes_before_update BEFORE UPDATE ON crm_meeting_notes
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_meeting_notes:' || json_array(OLD.id));
END;
CREATE TRIGGER crm_graph_crm_meeting_notes_delete AFTER DELETE ON crm_meeting_notes
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_meeting_notes:' || json_array(OLD.id);
END;

CREATE TRIGGER crm_graph_crm_meeting_notes_insert AFTER INSERT ON crm_meeting_notes
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_meeting_notes WHERE owner_id=NEW.owner_id AND id='legacy:crm_meeting_notes:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_meeting_notes:' || json_array(NEW.id) OR from_id='legacy:crm_meeting_notes:' || json_array(NEW.id) OR to_id='legacy:crm_meeting_notes:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_meeting_notes_update AFTER UPDATE ON crm_meeting_notes
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_meeting_notes:' || json_array(OLD.id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_meeting_notes:' || json_array(OLD.id)) != ('legacy:crm_meeting_notes:' || json_array(NEW.id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_meeting_notes WHERE owner_id=NEW.owner_id AND id='legacy:crm_meeting_notes:' || json_array(NEW.id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_meeting_notes:' || json_array(NEW.id) OR from_id='legacy:crm_meeting_notes:' || json_array(NEW.id) OR to_id='legacy:crm_meeting_notes:' || json_array(NEW.id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_email_imports_before_update BEFORE UPDATE ON crm_email_imports
BEGIN
 DELETE FROM crm_links WHERE owner_id=OLD.owner_id AND (from_id,to_id) IN
  (SELECT from_id,to_id FROM crm_graph_source_links WHERE owner_id=OLD.owner_id AND source_id='legacy:crm_email_imports:' || json_array(OLD.connection_id, OLD.message_id));
END;
CREATE TRIGGER crm_graph_crm_email_imports_delete AFTER DELETE ON crm_email_imports
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_email_imports:' || json_array(OLD.connection_id, OLD.message_id);
END;

CREATE TRIGGER crm_graph_crm_email_imports_insert AFTER INSERT ON crm_email_imports
BEGIN

 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_email_imports WHERE owner_id=NEW.owner_id AND id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id) OR from_id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id) OR to_id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;

CREATE TRIGGER crm_graph_crm_email_imports_update AFTER UPDATE ON crm_email_imports
BEGIN
 DELETE FROM crm_nodes WHERE owner_id=OLD.owner_id AND id='legacy:crm_email_imports:' || json_array(OLD.connection_id, OLD.message_id) AND (OLD.owner_id IS NOT NEW.owner_id OR ('legacy:crm_email_imports:' || json_array(OLD.connection_id, OLD.message_id)) != ('legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id)));
 INSERT INTO crm_nodes SELECT * FROM crm_graph_crm_email_imports WHERE owner_id=NEW.owner_id AND id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id)
 ON CONFLICT(owner_id,id) DO UPDATE SET text=excluded.text,metadata=excluded.metadata,
  created_at=excluded.created_at,updated_at=excluded.updated_at;
 INSERT INTO crm_links
 SELECT owner_id,from_id,to_id,created_at,updated_at FROM crm_graph_source_links
 WHERE owner_id=NEW.owner_id AND (source_id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id) OR from_id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id) OR to_id='legacy:crm_email_imports:' || json_array(NEW.connection_id, NEW.message_id))
 ON CONFLICT(owner_id,from_id,to_id) DO NOTHING;

END;
