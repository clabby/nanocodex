# Protected native input behavioral scenarios

Defined before implementation. No scenario enrolls a service, changes sudoers, or uses a real password.

- Preparing an absolute executable and cwd returns a five-minute ticket bound to the invoking uid, command, helper ephemeral key, and unpredictable request id. A different uid cannot consume it.
- An authenticated encrypted submission can execute its ticket exactly once. Changed ciphertext, approval signature, command binding, wrong recipient key, expired ticket, cancellation, and replay fail before execution.
- Restart loses all tickets and ephemeral keys; old submissions fail closed.
- The root-owned askpass receives synthetic password bytes only for the exact launched sudo parent PID and uid. Sudo without authentication never calls askpass; command stdin always remains /dev/null. Output and errors are discarded, including password echoes.
- The production process rejects non-root operation and insecure configuration. Root launchd activation is the only production entry; development tests exercise cryptography and the prompt protocol without enrolling or elevating.
- Local installation requires signed, hardened bundled executables and explicit macOS service approval. Enrollment remains unperformed in automated tests.

- A local peer cannot extend request admission beyond five seconds by sending bytes slowly, and each uid can hold at most four pending tickets.
- Production execution rejects an executable or parent path that is symlinked, non-root-owned, or group/world writable; interpreter arguments and command contents still require user trust.
