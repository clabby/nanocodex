# Continue mobile sessions in tmux

```sh
nanocodex2 continue
```

Opens one attached terminal per unfinished session used in the last **six hours**,
plus older sessions still running. It watches the existing managed session;
opening a window does not submit a prompt, restart a turn, move execution, or
copy files. Windows use the first 15 Unicode graphemes of the session title.

Inside tmux, windows are added to the current session. Outside tmux, the command
creates/reuses a `nanocodex` tmux session and attaches to it. Repeating the command
reuses existing attached windows by session ID, not by their abbreviated titles.
Existing windows are not closed when a session falls outside the time window.

```sh
nanocodex2 continue --dry-run          # preview selected sessions as JSON
nanocodex2 continue --hours 12         # choose another lookback window
nanocodex2 continue --session work     # choose a tmux session
nanocodex2 continue --detach           # prepare windows without switching terminals
```

Requires macOS or Linux, tmux, and the usual `nanocodex2 login` on the desktop. Each window uses
the directory where `continue` was invoked for subsequent local interactions;
already admitted work retains its execution location. Recent activity uses the
last accepted user message, not agent/tool output. Legacy summaries without that
field fall back to their last update. Merely opening a conversation does not yet
record a shared activity timestamp.

## Done

Use `/done` in the managed TUI or swipe left on a mobile conversation and choose
**Done**. Done is a saved organization flag, independent of whether the agent is
running or its last turn succeeded. Done sessions are excluded from `continue`,
including those still running. History and work are retained; no turn is cancelled.

Use `/undone` to restore a session. Mobile's **Done** filter lists completed-away
sessions and provides **Restore**. Headless equivalents:

```sh
nanocodex2 done AGENT_ID
nanocodex2 undone AGENT_ID
nanocodex2 attach AGENT_ID             # explicitly open any retained session
```

The API is `PUT /v1/agents/AGENT_ID/done` with `{ "done": true }` or
`{ "done": false }`. Account-owned list summaries expose `presentation.done`
and `presentation.doneAt`. Successful acknowledgements return `done` and
`done_at`; marking done does not change runtime status or recent-user timestamps.
Errors are surfaced without automatically retrying a write.
