# Account meeting library

The native recording library is account-owned D1 data (`NANOCODEX_CRM`) plus
original CAF audio in the existing `NANOCODEX_WORKSPACES` R2 binding, separate
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
  identity tombstone blocks later document/audio uploads (`410 meeting_deleted`), including a
  UUID deleted before its first upload. Deletion erases manifests and every raw
  audio part, including incomplete uploads. An admitted part upload that finishes
  after deletion removes its own part before returning 410.
- `POST /v1/meetings/UUID/audio`: JSON `{size,sha256}` declares the original
  finalized CAF (8 bytes–2 GiB, lowercase SHA-256 hex). The document must already
  exist. Returns `{audio:{size,sha256,part_size,count},uploaded_parts:[number],complete}`.
  Part size is 8 MiB, numbers start at 1. The last part may be shorter. The
  immutable manifest makes identical retries resumable and differing originals
  return `409 audio_conflict` for that capture UUID.
- `PUT /v1/meetings/UUID/audio/parts/N`: binary `application/octet-stream`, with
  exact `Content-Length` and `X-Content-SHA256` for this part. Returns
  `{part,size,sha256}`. Each part is streamed and checksummed before publication;
  differing bytes cannot replace an existing part. The first part must begin
  with a CAF version 1 header. Unknown lengths return 411; oversized parts 413;
  invalid checksums or sizes 400; wrong media types 415. All parts use the same
  direct-account and session-origin rules as documents.
- `POST /v1/meetings/UUID/audio/complete`: verifies the full original checksum
  over all immutable parts and publishes an idempotent `{audio,complete:true}`
  receipt. Missing parts return `409 audio_incomplete`. An incomplete recording
  cannot be downloaded. Native clients allow 300 seconds for this operation.
- `GET /v1/meetings/UUID/audio`: streams the original CAF by concatenating parts,
  with `Content-Length`, `X-Content-SHA256`, attachment disposition and `no-store`.
  No audio or incomplete audio returns 404. Native clients download to disk and
  verify the original checksum before making it playable.
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

Document JSON request bodies are incrementally bounded at 1 MiB without trusting Content-Length.
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

Audio admission JSON is bounded at 1 KiB. Each binary part is at most 8 MiB,
well below the Cloudflare ingress limit; the whole original is bounded at 2 GiB
(256 parts). R2 keys are scoped by a hash of owner, organization and team plus
capture UUID. Transfers never buffer a whole recording in the Worker or native
client. Unfinished parts stay resumable until meeting deletion. Audio has a
separate durable native sync receipt and cancellable background pump, so audio
transfer does not block transcript saves or summaries. Download is on demand.

## Reproducible local HTTP fixture

From the repository root:

```sh
pnpm --filter nanocodex-managed-service run test:meetings
cd js/managed
node scripts/meeting-library-fixture.mjs --port 8797 --persist ../../output/meeting-library-fixture-state
```

The fixture runs the production account proxy and meeting router over real
Miniflare HTTP and persistent D1/R2. Only local trusted authentication and the
external inference dependency are synthetic; these fixture helpers are never
included in the deployed Worker. Its synthetic owner key is
`ncx_live_abcdefgh1234_` followed by 43 `x` characters, matching native StartupFixture.
The local `POST /__fixture/provider` accepts `{fail:true|false,pause:true|false}`;
`GET` reports provider calls and synthetic requests for source-coverage evidence.
Use distinct recording UUIDs for concurrent native journeys. Controls affect the
whole fixture and must be coordinated. Test evidence is written to
`output/meeting-library-journey/` and `output/meeting-audio-journey/`
(traces, reproduction notes and persisted state). The audio journey uploads a
115 MB, hour-long synthetic CAF, resumes after restart, checks the exact original
download checksum, exercises authorization and concurrent part uploads, and
verifies physical deletion including an upload racing deletion.
