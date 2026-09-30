# Decision-first mobile Inbox

The product contract is **prepared work for judgment**, not a task manager or an activity firehose.

## Surfaces

- **For you:** worthwhile, prepared decisions. Missing, blocked or failed preparation is visible as work/coverage state, not a false “caught up”. Raw email stays in Mail; it does not become a decision because it exists.
- **Decision detail:** source context, recommendation, complete proposal and, when applicable, the actual editable persisted email draft. Approve & send is an explicit gesture on the shown draft. Chat is optional.
- **On my mind:** capture delegates preparation. Parked/done work must not start or publish an obsolete result.
- **Upcoming:** a compact calendar view with grounded briefings. Invitations do not establish attendance; absent CRM context is disclosed.
- **CRM / Chat:** retain visual context inspection and open-ended conversation respectively.

## Non-negotiable state semantics

1. Opening a prepared decision must not call a model. Prepare asynchronously and persist results before review.
2. A proposal must not imply research, availability, commitments or external effects that did not occur. Missing evidence is a specific blocked state, never a placeholder presented as ready.
3. Approval covers the exact recipients, subject, body, source and saved version shown. A changed version/content requires renewed review.
4. General decision responses record intent; they are not mail-send authorization or proof of completed external work.
5. A provider-accepted send is different from delivery. Unknown outcomes remain fenced against automatic repeat sends, including with a new operation ID.
6. Persist local edits safely, preserve them on conflict, and keep reconciliation available after reopening.
7. Retire account-scoped caches on sign-out and fence old responses against a new account, query or presentation lifetime.
8. A failed/partial read is not an empty inbox or complete source coverage.

## Gmail boundary

Gmail is the actual label/filter/mailbox organization surface. Not surfacing an item does **not** authorize archiving, spam, deleting or marking read. Low-priority legitimate mail is not spam.

Current-provider routing labels must prevent history-to-hydration races from admitting Spam/Trash/Draft or mail no longer in the opted-in Inbox source. Self-addressed mail may legitimately be Sent + Inbox; suppression of unnecessary own-sender decisions is separate from transport ingestion.

Existing filter changes are separate, reversible proposals. Broad sender archive rules can suppress security/billing/failure actions before an Inbox-scoped watcher sees them. Do not silently broaden ingestion to all archived mail or spam to compensate.

## Evidence and performance acceptance

Record the branch SHA, build and actual endpoint paths tested. Keep these categories separate:

- local unit/projection and failure-path tests;
- real Worker/account SQLite HTTP journeys with explicitly synthetic external inference/provider or fixture identity;
- logged-in production Nanocodex API draft/create/edit/reopen and provider evidence;
- native UI journeys and native rendering/navigation measurements;
- live provider send/delivery checks, only after approval of a designated exact self-addressed fixture.

Report first-observed versus warm timing separately; do not call the first request a confirmed server cold start. Small-sample p50/p95 are descriptive, not a service-level guarantee. UI cache-first latency must not be substituted for full model preparation or network send latency.

No credentials, cookies, provider authorization material, full private email corpus or raw authentication headers belong in reports. Sending, filter changes and source backfill remain bounded to their actual authorization.

## V1 boundaries to show, not hide

Drafts are persisted in the authenticated Nanocodex account and sent through the connected Gmail account after approval. They are **not synchronized to Gmail's Drafts folder**. A separate Gmail editor is therefore not a supported concurrent editor for these account drafts. Provider send read-back and recipient-side delivery verification are separate acceptance checks.

Current source routing is Inbox-scoped. Filter-archived mail and Spam are outside that opted-in ingestion boundary. A healthy configured watcher must be verified independently of repository configuration; an unavailable status/read must be shown as unknown coverage, not a completed background sync.

General “on my mind” work is read-only preparation. Supported evidence scope, source limitations and missing information remain visible. A blocked request is not completed research; a proposed external action is not an executed action. Non-email judgments must not be labeled “sent”.
