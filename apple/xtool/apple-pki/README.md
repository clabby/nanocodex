# Public Apple profile trust anchor

Downloaded from the official [Apple PKI page](https://www.apple.com/certificateauthority/)
link https://www.apple.com/appleca/AppleIncRootCertificate.cer on 2026-09-30.
DER SHA256: `b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024`.
The PEM is a public CA certificate, not a private key or Apple SDK artifact.

Linux publication validates embedded provisioning-profile CMS chains against this
pinned anchor with OpenSSL `purpose=any`. It does not establish Apple's platform
code-signing policy, revocation status, certificate issuance for a new Linux key,
or successful installation. Unknown/new roots fail closed; do not disable critical
extension handling or change the pin merely to make a certificate pass.
