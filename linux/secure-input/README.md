# Protected Linux secure sudo recipient

This isolated Rust/C package implements the macOS v1 wire format in
`../../macos/secure-input/PROTOCOL.md`. It is **not a terminal password prompt**.
The Hand transports signed public tickets and signed encrypted approvals only;
the root daemon receives a synthetic/real secret only after verifying the pinned
backend P256 signature and consuming the ticket. P256 ECDH, HKDF-SHA256 (empty
salt, request ID info), and AES-256-GCM nonce12+ciphertext+tag16 match mobile.
The root-held persistent P256 ticket identity is pinned **independently** per
machine/account backend. A key learned from Hand output is not enrollment.

## Trust and enrollment (never agent-operated)

A trusted local administrator must audit/build the release, verify release hashes
and the backend approval public key via independent authenticated channels, and
select the exact existing non-root **transport UID and login/authentication UID** pair. `build-release.sh`
builds only. `install-local.sh` requires a local root TTY and explicit independently
verified hashes; it stages copies in a root-private directory before verification.
It neither runs sudo nor changes sudoers, PAM, timestamp policy, sysctl policy, nor
enables the daemon. It never overwrites enrollment. The installed helper's
`--enroll BACKEND_PUBLIC_KEY TRANSPORT_UID SUDO_UID` likewise requires root and a TTY. No secret
is accepted or printed during enrollment. `/etc/nanocodex-secure-input` is root0700,
`configuration.json` root0600 containing backend key, signing private identity,
and the pinned transport/authentication UID pair. Re-enrollment requires deliberate local admin removal/review.
Complete independent backend pinning of the printed **public** helper identity,
then locally install the reviewed systemd unit and enable it. No production
installation/enrollment is performed by tests or this implementation task.

**linux-paradigm's uid998 `nanocodex` service cannot authenticate with the `ubuntu`
user's password.** Sudo/PAM authenticates the invoking UID. Socket peer UID is
SO_PEERCRED-bound and must equal root-enrolled `transport_uid`. Sudo invokes the
separately root-enrolled `sudo_uid`; the ticket displays and signs that authentication
UID. A trusted local admin may deliberately enroll service998 -> login1000, but
**never** by a caller-supplied UID or an agent-driven change. Enrolling998 -> 998
still cannot accept ubuntu1000 credentials. With no locally trusted mapping the
feature is unavailable. Do not loosen sudoers/PAM or bypass authentication. Backend
and mobile must verify the displayed sudo UID before authorization.

## OS boundary

Fixed root-owned `/run/nanocodex-secure-input.sock` mode0666 transports metadata
and ciphertext. No symlink aliases are allowed in protected paths (Linux uses
`/run`, not `/var/run`). Each path component is opened O_NOFOLLOW relative to its
verified parent and must be root-owned and not group/other-writable. Helper and
askpass installation are checked; daemon's kernel executable inode must match.
Approved executable must be a protected regular executable; its device/inode are
bound at prepare and rechecked at dispatch. This is non-root immutability, **not**
a file-content hash or a guarantee against trusted root modifying the program.

**Interpreter caveat:** approval of `/usr/bin/bash`, Python, another interpreter,
a script, loader, plugin host, or command that reads user-controlled files also
approves whatever code/arguments that privileged program loads. Cwd and argument
files are not made immutable. Do not approve interpreters or mutable payloads
unless their whole privileged behavior is intended. Native helper does not sandbox
approved programs; a malicious approved root command can disclose its own data.
No secret is placed on command stdin, argv, env, or normal Hand stdout/stderr.

Constructor/main hardening disables core dumps and PR_SET_DUMPABLE before keys
are loaded; child/askpass repeat hardening after privilege transitions. Startup
and execution require `fs.suid_dumpable=0` because Linux UID transitions reset
dumpability **before** a following prctl; no unsafe same-user ptrace window is
accepted. Root can inspect root processes and is necessarily trusted. A compromise
of system root/kernel, release supply chain, backend approval signing key, or
mobile endpoint is outside this boundary.

The daemon drops supplementary groups/gid/uid to the fixed enrolled authentication UID for fixed
`/usr/bin/sudo -A -k -- executable argv...`, minimal env, all stdio `/dev/null`.
Existing distribution sudo/PAM policy remains authoritative. A separate root-owned
4755 askpass writes only into sudo's FIFO. Its endpoint is in root0700 directory,
mode0600, expires with the 120-second command, allows one delivery (consumed before
write), and validates root SO_PEERCRED, actual peer PID/executable, real UID and
actual sudo parent against the launch. It accepts no caller-supplied output path.
All output/errors are fixed receipts; errors never reflect rejected input.

One request JSON object + LF + EOF, <=32768 bytes, five-second absolute monotonic
framing deadline, two-second output/askpass deadlines. Unknown fields, trailing
frames, malformed encoding, wrong peers, expired/replayed/tampered approvals are
rejected. Global/per-UID pending caps and 24 admissions/UID/minute bound memory and
work. The serialized daemon limits one executing command to 120 seconds; one
user can delay other requests, not create unbounded concurrent privileged jobs.

## Tests

`cargo test --locked` and `build-release.sh` on Linux. Tests use only synthetic
inputs and never install setuid binaries, enroll real keys, invoke production
sudo, alter PAM/sudoers, or escalate. OS tests cover peer UID/PID, no-follow path
ownership/mode, strict framing/deadlines, dumpability and fail-closed uninstalled
execution. Cryptographic tests cover the wire signing/digest, decrypt dispatch,
one-use/expiry/UID binding, tampering, pending/rate limits and output redaction.

### Disposable privileged integration suite (never on a user's computer)

Ordinary tests above remain unprivileged and never install/enroll. The separate
`tests/disposable_e2e.py` is deliberately destructive and **only** for a newly
provisioned dedicated Linux sandbox/VM controlled by the test operator. It fails
unless root, UID998/1000 are unused, all installed paths are absent, and a trusted
controller has independently created root `/etc/nanocodex-disposable-secure-input-test`
containing `synthetic-only-disposable`. That marker is not a release bypass: the
helper and askpass contain no test mode, relaxed checks, or alternative paths.

In that disposable environment only, install distro `sudo`, PAM and Python's
`cryptography`; build this package; then run `/usr/bin/python3 tests/disposable_e2e.py`.
The script compiles `tests/e2e-os-boundary.c` against the unchanged release runner,
sets that root-owned test fixture4755 for the actual setuid boundary checks,
and removes its setuid mode during cleanup. The controller generates
synthetic keys/password at runtime, invokes the unchanged local installer in a
virtual TTY, independently captures/pins the public enrollment result, and
requires real sudo/PAM password authentication. It tests separate peer998/admin1000,
correct/wrong password, concurrent replay, one-use, cancellation, wrong signer,
restart/framing, actual setuid askpass fake-parent rejection, actual core/dumpability
and UID transition boundaries, same-UID `/proc/PID/mem` denial, SIGSEGV without
core, release 120-second timeout and endpoint cleanup, and absolute framing
deadline. It removes its freshly created users/policy/config/binaries on exit.
Never reuse production enrollment, private keys or passwords, or interpret a
sandbox pass as evidence that a live computer has been installed/enrolled.

## Packaging and residual memory limits

`package-release.sh` builds a tarball plus `SHA256SUMS` in the Cargo target package
directory. Archive permissions are ordinary0755: setuid is applied only by the
separately trusted local installer after staging and hash verification. No
post-install hook automatically enrolls/enables a root service. Distribution
operators must review artifact provenance and the unit independently.

Zeroizing buffers cover decoded private identity, HKDF output, decrypted JSON,
parsed password and askpass stack storage. AES, GHASH and POLYVAL zeroize features
also enable their supported key/state scrubbing. This is best effort, not proof
that compiler/register/allocator/framework copies disappear. In particular fork
inherits the root Rust heap (plaintext JSON, parsed string and crypto state); the
child explicitly wipes the password slice but **not every inherited heap copy**.
Constructor/core0/nondumpable hardening and the fail-closed suid_dumpable0 policy
prevent same-UID inspection across the transition, and exec replaces that heap.
Root/kernel compromise and an approved malicious privileged command are outside
this confidentiality boundary. `/proc` peer executable verification requires the
root helper's kernel inspection authority; restricted containers without it fail
closed, rather than omit the check.
