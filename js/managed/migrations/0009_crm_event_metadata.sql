-- Partial dates retain their original text. *_ms values are UTC period floors for
-- sorting/filtering only and must never be presented as observed timestamps.
ALTER TABLE crm_events ADD COLUMN start_precision TEXT NOT NULL DEFAULT 'datetime' CHECK(start_precision IN ('year','month','date','datetime'));
ALTER TABLE crm_events ADD COLUMN end_precision TEXT CHECK(end_precision IN ('year','month','date','datetime'));
UPDATE crm_events SET end_precision='datetime' WHERE end_at IS NOT NULL;
-- Keep the original precision CHECK compatible; this additive column is authoritative.
ALTER TABLE crm_interactions ADD COLUMN occurred_precision TEXT NOT NULL DEFAULT 'datetime' CHECK(occurred_precision IN ('year','month','date','datetime'));
UPDATE crm_interactions SET occurred_precision=precision;
ALTER TABLE crm_events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata) AND json_type(metadata)='object' AND length(CAST(metadata AS BLOB))<=16384);
ALTER TABLE crm_interactions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata) AND json_type(metadata)='object' AND length(CAST(metadata AS BLOB))<=16384);

-- Rebuild only the child table; preserve every assertion, key, and provenance field.
DROP TRIGGER crm_participation_immutable;
DROP TRIGGER crm_participation_person;
DROP TRIGGER crm_company_organizer_update;
CREATE TABLE crm_event_participation_new (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, event_id TEXT NOT NULL, record_id TEXT NOT NULL, person_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('invited','expected','attended','declined','unknown')),
 role TEXT NOT NULL DEFAULT 'attendee' CHECK(length(trim(role)) BETWEEN 1 AND 128),
 metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata) AND json_type(metadata)='object' AND length(CAST(metadata AS BLOB))<=16384),
 origin TEXT NOT NULL CHECK(origin IN ('user','source','inferred')),
 sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources)='array' AND json_array_length(sources)<=50),
 confidence TEXT CHECK(confidence IN ('low','medium','high')), rationale TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,event_id,record_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES crm_records(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,event_id) REFERENCES crm_events(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,person_id) REFERENCES crm_records(owner_id,id) ON DELETE CASCADE,
 CHECK(origin='user' OR json_array_length(sources)>0),
 CHECK(origin!='inferred' OR (confidence IS NOT NULL AND rationale IS NOT NULL AND length(trim(rationale))>0))
);
INSERT INTO crm_event_participation_new(owner_id,id,event_id,record_id,person_id,status,role,origin,sources,confidence,rationale,created_at,updated_at) SELECT owner_id,id,event_id,record_id,person_id,status,role,origin,sources,confidence,rationale,created_at,updated_at FROM crm_event_participation;
DROP TABLE crm_event_participation;
ALTER TABLE crm_event_participation_new RENAME TO crm_event_participation;
CREATE INDEX crm_participation_person ON crm_event_participation(owner_id,person_id,created_at,id);
CREATE INDEX crm_participation_event ON crm_event_participation(owner_id,event_id,created_at,id);
CREATE INDEX crm_participation_record ON crm_event_participation(owner_id,record_id,event_id);
CREATE TRIGGER crm_participation_immutable BEFORE UPDATE ON crm_event_participation
WHEN NEW.owner_id!=OLD.owner_id OR NEW.id!=OLD.id OR NEW.event_id!=OLD.event_id OR NEW.record_id!=OLD.record_id OR NEW.person_id IS NOT OLD.person_id OR NEW.origin!=OLD.origin
BEGIN SELECT RAISE(ABORT,'crm_event_immutable'); END;
CREATE TRIGGER crm_participation_person BEFORE INSERT ON crm_event_participation
WHEN NOT EXISTS(SELECT 1 FROM crm_records WHERE owner_id=NEW.owner_id AND id=NEW.record_id
 AND ((kind='person' AND NEW.person_id IS NEW.record_id) OR (kind='company' AND NEW.person_id IS NULL)))
BEGIN SELECT RAISE(ABORT,'crm_invalid_person'); END;
