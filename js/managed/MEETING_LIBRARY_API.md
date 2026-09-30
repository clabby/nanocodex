# Account meeting library

The native recording library is account-owned D1 data (`NANOCODEX_CRM`), separate
from CRM calendar invitations and the optional ephemeral meeting preview feature.
Apply the managed D1 migrations before running the backend. No agent, Connect
grant or inference key may access it. Requests require a persistent direct account
session or account API key with `agents:read`, `agents:write` and `tools:use`.
Session mutations must carry an exact same-origin `Origin` header.

## HTTP contract

- `GET /v1/meetings?limit=30&cursor=...`: `{meetings:[metadata],next_cursor}`.
  Limit is 1–100. Opaque cursors are scoped to owner, organization and team.
  Metadata excludes transcript and notes; ordering is started_at descending,
  then UUID descending.
- `GET /v1/meetings/UUID`: `{meeting:record}`.
- `PUT /v1/meetings/UUID`: JSON `{revision,title,started_at,duration_seconds,
  transcript,notes,partial}`. First revision may be any positive safe integer.
  Updates require a strictly greater revision. An identical current revision
  and normalized payload is an idempotent retry; differing same/older revisions
  return `409 revision_conflict`.
- Native clients additionally send `If-Match: "N"`, the last acknowledged server
  revision, independently of local checkpoint revisions. `"0"` requires an absent
  recording. The precondition is checked atomically with persistence. A stale
  higher local revision cannot overwrite another device's edits. Identical retry
  remains safe even with its original precondition. Older callers without this
  optional header retain the monotonic-revision contract.
- `DELETE /v1/meetings/UUID`: 204, idempotent. Content is erased and a permanent
  identity tombstone blocks later uploads (`410 meeting_deleted`), including a
  UUID deleted before its first upload.
- `POST /v1/meetings/UUID/summarize`: JSON `{revision}`; returns `{meeting}`.
  Revision must match. The Markdown summary includes key points, decisions and
  actions derived from transcript and user notes. A ready result is immutable
  and returned without repeated inference. Full source is processed in ordered
  UTF-8/JSON-bounded rolling chunks, never silently reduced to head/tail excerpts.

A record contains `id,title,started_at,updated_at,duration_seconds,transcript,
notes,partial,revision,summary,summary_status`. Dates are ISO strings;
`summary_status` is `none`, `ready` or `unavailable`. Editing resets summary state.
Known inference failure preserves all original content and releases the claim,
allowing up to three attempts per revision. A crashed claim expires after two
minutes. Concurrent generation does not spend twice. Overall generation has a
90-second deadline; native clients should allow at least 120 seconds.

## Resource boundaries

Request bodies are incrementally bounded at 1 MiB without trusting Content-Length.
Title: 512 UTF-8 bytes; transcript: 700 KiB; notes: 64 KiB. Duration is a nonnegative
safe integer, partial is Boolean, and all JSON fields are validated. Each account
may retain 1,000 live recordings and 10,000 identities including tombstones.
These quotas include every organization/team slice belonging to the account.

Summary generation reserves up to 40 source chunks, each at most 20 KiB encoded
UTF-8 and 600 output tokens, against an account-wide budget of 120 provider calls
per UTC day. Inputs requiring more than 40 chunks return
`413 meeting_summary_source_too_large`; no upload is modified. Insufficient daily
budget returns `429 summary_quota`. Provider failure returns the preserved record
with `summary_status: unavailable`, not a fabricated summary.

## Reproducible local HTTP fixture

From the repository root:

```sh
pnpm --filter nanocodex-managed-service run test:meetings
cd js/managed
node scripts/meeting-library-fixture.mjs --port 8797 --persist ../../output/meeting-library-fixture-state
```

The fixture runs the production account proxy and meeting router over real
Miniflare HTTP and persistent D1. Only local trusted authentication and the
external inference dependency are synthetic; these fixture helpers are never
included in the deployed Worker. Its synthetic owner key is
`ncx_live_abcdefgh1234_` followed by 43 `x` characters, matching native StartupFixture.
The local `POST /__fixture/provider` accepts `{fail:true|false,pause:true|false}`;
`GET` reports provider calls and synthetic requests for source-coverage evidence.
Use distinct recording UUIDs for concurrent native journeys. Controls affect the
whole fixture and must be coordinated. Test evidence is written to
`output/meeting-library-journey/` (trace, reproduction notes and persisted state).
