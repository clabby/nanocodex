# Company and team context

Accounts keep their credentials, private data, personal sessions, and personal
memory. A company has a shared knowledge partition and can contain multiple
teams with separate membership and knowledge. Platform administrator access is
configured independently: company ownership never grants platform administration.

## Membership

Open **Account → API access → Teams** to create a company, create a team within
a company you own, accept an invitation, or manage membership. An account can
belong to multiple companies and teams. Company membership is required for
access to any of its teams; company membership alone does not grant access to
team knowledge. Removing company membership also prevents access to its teams.

Owners manage invitations and member roles. Writers contribute sessions and
memory. Readers recall shared context but cannot contribute or manage members.
At least one owner must remain. Invitations expire after seven days, may be
restricted to a specific account ID, and can be revoked. Acceptance is single
use; replay by the accepting member is idempotent and cannot restore a removed
membership. Tokens are displayed only when created and only their digests are
stored. Owners can inspect invitation status and revoke pending invitations.

The web interface produces invitation links with the token in the URL fragment.
Opening a link fills an acceptance form and removes the fragment from the
address bar. The recipient must explicitly accept. Share links privately.

Companies and teams use the same API. A top-level entry is a company; an entry
with `company_id` is one of that company's teams. Creation with `company_id`
requires ownership of the company. Deeper nesting is not supported.

| Method | Path | Operation |
| --- | --- | --- |
| GET, POST | `/v1/teams` | List live memberships; create with `name` and optional `company_id` |
| GET | `/v1/teams/:id` | Read company/team and members; owners also see invitation status |
| POST | `/v1/teams/:id/invitations` | Invite with `role` and optional `user_id` |
| POST | `/v1/teams/:id/invitations/accept` | Accept with `token` |
| DELETE | `/v1/teams/:id/invitations/:invitationId` | Revoke invitation |
| PATCH | `/v1/teams/:id/members/:userId` | Set `role` |
| DELETE | `/v1/teams/:id/members/:userId` | Remove membership |

## Sessions and knowledge

New sessions default to personal. Use **New team session** and explicitly choose
a company or team to contribute to its context. Scope is immutable after
creation. Completed user/assistant history contributes automatically to the
selected partition, and memory writes default to that shared partition without
a separate sharing request each time. A team's contributions remain in that
team; they are not automatically copied to the company or sibling teams.
Personal conversations and memories are never automatically copied to shared
partitions, and personal memory is not loaded into shared sessions.

API clients create sessions with `POST /v1/agents` and
`"scope": {"type":"team","team_id":"COMPANY_OR_TEAM_UUID"}`. Omission or
`{"type":"personal"}` creates a personal session. The JavaScript managed SDK
accepts the same `scope` option on `Agent.create` and `Agent.createAndPrompt`.
Session state exposes retained `scope`; a creation replay cannot change it.

History and memory HTTP requests select shared knowledge with
`?team_id=COMPANY_OR_TEAM_UUID`; omission retains personal account behavior.
Every request applies live membership and the account's normal capabilities.
Personal sessions can use the memory and history tools with an explicit
`team_id` to read authorized shared context while continuing to contribute only
to personal context. Readers cannot write memory or create shared sessions. Shared selection is not
available through Connect grants. Account credentials and external service
connections remain owned by the session creator.

Membership authority uses the Organization Durable Object independently of
personal account organization grants. Knowledge uses isolated MemoryScope
partitions. Removal blocks subsequent authorized operations, but cannot erase
content someone already received. Revocation during a running external model
request cannot retract context already sent to that model.

## Verification

Run `pnpm --filter nanocodex-managed-service run test:company-teams` for public
HTTP membership and context journeys. Generated traces and local run evidence
belong under ignored `output/company-teams/`. These local journeys use synthetic
accounts; external identity/model dependencies use explicit fixtures. They do
not deploy the service.
