# Sharing a managed Chat thread

A thread owner can create **view-only** or **read/write** bearer links from the Chat Share menu or `/share` in the TUI. Anyone who has a link can open the same conversation in the website without an account. A read/write link admits real guest messages into that thread, starts AI turns, and streams activity in the normal Chat transcript. There is no separate comments channel. Guests are labeled **Guest**; the link is transferable and does not identify a person.

Keep links private. Everyone with a link can read shared prompts, reasoning, tools and replies, including past transcript content and subsequent messages until the link is revoked. Messages sent with a write link use the owner's model billing, but guest turns do not acquire the owner's account connector, Vault, Hand or other full-account tool permissions. Treat a write link as authority to consume model usage and influence subsequent conversation context. Guests should not be given sensitive context they should not see.

## Owner controls

Use Share → create a view or write link, copy the URL, or revoke an active link. `/share read`, `/share write`, `/share list`, and `/share revoke <link-id>` offer the same TUI actions. The bearer is in the URL fragment, never returned again after creation and not sent to the server in request URLs. Share only over a trusted channel. Revocation blocks new reads, streams, and turn admissions immediately; a turn already admitted may continue. Revocation does not retract messages already seen or saved by link holders.

## Protocol

| Method | Route | Who | Action |
| --- | --- | --- | --- |
| `GET` / `POST` | `/v1/agents/:id/share-links` | Owner | List or create `{ "permission": "read" | "write" }` |
| `DELETE` | `/v1/agents/:id/share-links/:link-id` | Owner | Revoke |
| `GET` | `/v1/shared/:id` | Link bearer | Thread metadata |
| `GET` | `/v1/shared/:id/events/history` | Link bearer | Cursor-paginated shared transcript |
| `GET` | `/v1/shared/:id/events` | Link bearer | SSE for live shared events |
| `POST` | `/v1/shared/:id/turns` | Write-link bearer | Admit `{ "id": "stable-turn-id", "input": "message" }` as a real thread turn |

Guest requests send `Authorization: Bearer <fragment-token>` and omit account cookies. History cursors and SSE resume follow the normal event log. Duplicate turn IDs retry idempotently for the same link and input. A view-only link cannot submit. Cross-origin mutations are rejected. Older comment-only links created before the write-turn upgrade do not gain turn authority; create a new write link.
