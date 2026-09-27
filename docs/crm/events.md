# CRM events and connections

These APIs remain available for existing integrations. New untyped knowledge can
use the [CRM graph](graph.md); legacy events and participation are synchronized
into it with their original provenance.

An event is a titled occurrence with dates, provenance, and optional JSON metadata.
Conferences, funding announcements, acquisitions, and other milestones use the same
`crm_events` API and storage. There is no required event type or dedicated funding
entity.

`crm_event_participation` links an event to a person or company record. Funds can
be represented by company records. Each link has a free-text role, provenance,
optional metadata, and a separate attendance status. For example, an event titled
“Example Labs seed round” can link Example Labs as `recipient`, Example Ventures
as `lead_investor`, and a person as `angel_investor`. The default attendance status
is `unknown`; an investment role does not assert attendance.

Store connections as participation links, so they are traversable. Metadata can
hold descriptive values such as amount and currency, but should not be the only
place an investor's record ID appears. List events with `record_id`, then get an
event's paginated roster to follow a path through it. Shared participation is
context for a possible introduction, not evidence that two participants know one
another. Durable employment and personal relationships remain relationship edges.

Events, participation links, and interactions accept a `metadata` JSON object of
at most 16 KiB. Omission on edit preserves it; supplying an object replaces it;
`{}` clears it. Provenance requirements also apply when adding metadata. Preserve
unknown amounts and dates rather than inventing values.

Event dates and interaction dates accept `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or an
absolute RFC3339 timestamp. Responses retain the supplied value and explicit
precision. Internal numeric sort keys use the UTC beginning of a partial date's
period. Time filtering uses these sort keys, not interval overlap, and must not be
interpreted as evidence of an exact occurrence time.

Interactions retain shared observations, such as a call or introduction, and can
link to an event. Their participants may be people or companies. Person and company
timelines include their event participation and interactions. CRM events are
independent of Google Calendar; saving one does not send invitations or create a
calendar entry.
