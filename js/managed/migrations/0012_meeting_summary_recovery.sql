-- Successful summary receipts remain immutable; bounded failed/crashed attempts can recover.
ALTER TABLE meeting_library ADD COLUMN summary_claim_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meeting_library ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0;
-- Old unavailable receipts are not successful results and may retry under the new lease.
UPDATE meeting_library SET summary_revision=NULL WHERE summary_status='unavailable';
