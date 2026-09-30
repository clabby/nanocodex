# Protected native sudo input (macOS 14+)

This package implements the native recipient used by `native_secure_input`. The
account route authenticates the user, verifies the independently enrolled helper
identity, and signs a phone-encrypted approval envelope. The root daemon verifies
that approval, decrypts in root memory, consumes the exact argv/cwd/uid ticket,
and invokes `/usr/bin/sudo -A -k`. Existing sudo authorization policy remains in
force. The command receives a fixed minimal environment and `/dev/null` for all
standard descriptors. Only a bounded exit status returns to the account.

The password travels from the root broker through a root-only Unix socket to a
small root-owned setuid askpass executable, then through sudo's own private
askpass pipe. It never travels through the command's stdin, argv, environment,
ordinary Hand RPC, or filesystem. Askpass derives its broker socket from its
actual parent PID; the broker checks the root peer, actual sudo PID and uid and
allows one delivery. A sudo NOPASSWD command never calls askpass. The setuid helper
rejects non-pipe stdout and non-setuid invocation. The root daemon disables core dumps before loading keys; the sudo runner verifies
that policy before fork and again in its child. The root daemon rejects
unsigned/ad-hoc/debug binaries and verifies askpass's matching Developer Team,
hardened runtime, identity, and root ownership.

This uses a signed Installer package with local macOS administrator approval.
It is not an SMAppService service and does not alter sudoers. Both the extra
setuid executable and root daemon must be reviewed as privileged production
code. Installation is never attempted by builds, tests, or a normal Hand request.

## Build and enrollment

Run `swift test --package-path macos/secure-input` from the repository root.
The tests use synthetic input and require no root, signing identity or enrollment.
Build the distributable installer with:

```sh
macos/secure-input/build-installer.sh \
  'Developer ID Application: DISTRIBUTOR (TEAM)' \
  'Developer ID Installer: DISTRIBUTOR (TEAM)' \
  SERVER_P256_X963_PUBLIC_KEY_BASE64
```

The script builds and signs both binaries and a package under ignored
`output/secure-input-native/installer`. It never installs anything. The distributor
must notarize/staple and distribute through its normal trusted release channel.
An administrator reviews and opens that package locally; macOS Installer requests
administrator approval before installing root-owned files and starting launchd.
Production requires a real Developer ID signature, hardened runtime, no
get-task-allow entitlement, root-owned non-writable parent directories and
root:wheel modes 0755 (daemon), 04755 (askpass), 0700 (configuration directory),
and 0600 (configuration). No ad-hoc/debug enrollment fallback exists.

Enrollment generates the helper signing identity locally in the protected root
configuration. The installer's local output contains the **public** identity key.
A local administrator can retrieve it with the installed helper's `--identity`
operation under local administrative authority. Independently associate that
public key with the correct machine in backend `NATIVE_SECURE_INPUT_HELPERS`.
Never accept a key first learned from ordinary Hand/model tool output as a pin.
The package pins the backend approval key supplied at build time; the backend's
private P256 JWK belongs only in `NATIVE_SECURE_INPUT_SIGNING_KEY`. Missing or
mismatched enrollment fails closed. Package upgrades preserve the existing
identity and approval key; key rotation requires explicit local re-enrollment.

See [PROTOCOL.md](PROTOCOL.md) for the adapter and encryption contract. Binding is
to exact argv/cwd/uid, not the contents of mutable scripts or executable files.
A user approving a command must trust those files. An approval is consumed before
decryption/execution; cancel and five-minute expiry invalidate pending tickets.
A daemon restart discards all pending tickets and their ephemeral keys. The public local socket admits at most 24 requests per peer UID per minute and requires a complete frame within one second; a same-user process can still deny its own availability. Command
execution has a 120-second bound; timeout or uncertain delivery yields
`outcome_unknown` and must never be retried automatically. Cancellation before
submission removes the pending request; it cannot undo an already-started command.
All command output is discarded. This version supports sudo commands only,
not native application fields, general terminal stdin, SSH passwords or CUA.

## Verification limits

The automated boundary tests cover helper signatures, encrypted approval,
command-digest tampering, wrong uid, expiry, cancellation, one-use replay and
restart rejection. They do not claim a live privileged enrollment or a successful
sudo authentication: those require a locally approved signed package on a
controlled Mac. No production password is used by tests.

Apple's [sudo tgetpass implementation](https://github.com/apple-oss-distributions/sudo/blob/main/sudo/src/tgetpass.c)
creates a private CLOEXEC pipe, forks askpass directly, drops to the invoking uid,
and execs the askpass executable. The setuid bit reestablishes the askpass boundary;
its `getppid()` identifies the authenticating sudo process before command monitor
creation. Unexpected sudo behavior fails closed instead of forwarding a secret.
Swift/CryptoKit and Foundation may retain copies of decrypted strings; explicit
Data and C buffer wiping is best effort, not a guarantee of total zeroization.
Root compromise and malicious administrator-installed sudo plugins are outside
this boundary. Same-user shell access cannot read root memory, private sockets,
or either setuid process through ordinary debugging.

## Approved privileged code is trusted

Confidentiality is not promised against the command the user authorizes to run as
root. That code can inspect root memory, configuration keys, and other privileged
processes. Decrypted buffers can remain alive while it runs. The executable and
every path component must be root-owned, non-symlinked and not group/world writable;
use the exact immutable `/nix/store/.../activate` path for Nix activation. Mutable
aliases and user-writable executables fail closed. This does not validate script
contents or interpreter arguments: `/bin/sh /user/writable/script` grants that
script root authority. The user must trust all code and files the command loads.
