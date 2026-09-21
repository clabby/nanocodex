# Connected-account HTTP tool audit

Checked 2026-09-15. These are authenticated JSON HTTP request tools, not generated
SDK methods. Each accepts a documented HTTP `method`, absolute API `path`, optional
JSON `body`, and an exact account selector. Discovery does not imply that every
provider endpoint is permitted by the account's scopes or subscription.

## Source and method checks

The HTTP verbs below were checked against the provider-owned specifications.
The Contacts tool is deliberately narrower than the People API because our
existing OAuth connector requests `contacts.readonly`.

| Tool | Supported HTTP verbs | Primary reference |
| --- | --- | --- |
| `github_request` | GET, POST, PUT, PATCH, DELETE | [GitHub OpenAPI](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json) |
| `gmail_request` | GET, POST, PUT, PATCH, DELETE | [Gmail discovery](https://gmail.googleapis.com/$discovery/rest?version=v1) |
| `gdrive_request` | GET, POST, PATCH, DELETE | [Drive discovery](https://www.googleapis.com/discovery/v1/apis/drive/v3/rest) |
| `gcalendar_request` | GET, POST, PUT, PATCH, DELETE | [Calendar discovery](https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest) |
| `gtasks_request` | GET, POST, PUT, PATCH, DELETE | [Tasks discovery](https://tasks.googleapis.com/$discovery/rest?version=v1) |
| `gdocs_request` | GET, POST | [Docs discovery](https://docs.googleapis.com/$discovery/rest?version=v1) |
| `gsheets_request` | GET, POST, PUT | [Sheets discovery](https://sheets.googleapis.com/$discovery/rest?version=v4) |
| `gslides_request` | GET, POST | [Slides discovery](https://slides.googleapis.com/$discovery/rest?version=v1) |
| `gcontacts_request` | GET | [People discovery](https://people.googleapis.com/$discovery/rest?version=v1); scope in `egress/src/connectors/google.ts` |
| `slack_request` | GET, POST | [Slack Web API](https://docs.slack.dev/apis/web-api/) |
| `x_request` | GET, POST, PUT, DELETE | [X OpenAPI](https://api.x.com/2/openapi.json) |
| `spotify_request` | GET, POST, PUT, DELETE | [Spotify reference](https://developer.spotify.com/documentation/web-api/reference) |
| `soundcloud_request` | GET, POST, PUT, DELETE | [SoundCloud OpenAPI](https://developers.soundcloud.com/docs/api/explorer/api.json) |

The catalog includes provider documentation links and concrete read/write examples.
Unsupported verbs are rejected before network dispatch. Paths are restricted to
the selected provider and its managed egress policy. Request bodies and responses
are bounded; binary uploads are not supported by these JSON tools. No writes are
retried automatically. Slack's HTTP 200 responses with `ok:false` are failures.

## Spotify recently played

The exact call is:

```json
{"method":"GET","path":"/v1/me/player/recently-played?limit=20"}
```

[Spotify documents](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)
this endpoint with the `user-read-recently-played` scope, which our OAuth request
includes. Use `limit` from 1 to 50. Optional `before` or `after` cursors use Unix
milliseconds; do not send both. The method is `GET`, not `recently_played`.
A 429 is a provider rate limit: wait the returned `retry_after` before a bounded
read retry. Missing scopes or account eligibility can produce 403. Playback GETs
can return 204 when there is no playback state.

Playlist examples use the current `/v1/playlists/{id}/items` endpoint, including
[`POST` with `uris`](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist)
and [`DELETE` with `items`](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist).
SoundCloud playlist bodies use `{playlist:{...}}` and track URNs, per its OpenAPI.

## Verification boundaries

`connector-tools.test.ts` checks each provider's documented example through the
actual tool router and managed egress boundary; recently played; Google document
creation paths; forbidden methods; selector/grant checks; JSON writes; rate limits;
Slack failures; and empty playback responses. Music broker tests cover OAuth,
refresh, request forwarding, multi-account selection, and revocation.

These transport tests use provider fixtures. They do not establish that every
operation succeeds on a particular user's account. Read-only production checks
are separate; connected accounts can be checked live, while Slack and SoundCloud
require a user connection before authenticated live verification. Testing writes
must not send messages, modify playlists, or alter user files merely to audit the
HTTP transport.
