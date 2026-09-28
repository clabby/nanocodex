# Native Swift wire integration

Defined before the test harness. Run on macOS 14 or later from this directory:

```sh
swift test --jobs 3
```

One journey uses the public production APIs of InboxCore and SecureInputCore:

1. `Broker.prepare` creates a signed ticket for a synthetic uid and an exact command containing Unicode and quoted arguments. The fixture verifies its helper signature with the independently held helper public key.
2. `ManagedClient.describeNativeSecureInput` receives metadata derived from that actual ticket through an in-process URLProtocol transport. The production client verifies the command digest.
3. `ManagedClient.submitNativeSecureInput` encrypts a synthetic password. The transport must receive only the request id, ephemeral public key and ciphertext, never plaintext.
4. The transport signs that actual envelope using a synthetic server approval key. `Broker.submit` decrypts it and invokes a callback exactly once with the original command, uid and exact UTF-8 password bytes.
5. A repeated envelope is rejected without another callback. The original helper completion is mapped to a private receipt and the production mobile client observes `completed`.

A signature, digest, key derivation, authenticated encryption, encoding or receipt incompatibility must fail this journey. The transport and execution callback are synthetic; cryptography and client/helper protocol implementations are production code. No real sudo, privileged helper installation, enrollment, network service, or secrets are used. JavaScript backend authorization, ticket verification and receipt mapping are **not** exercised by this Swift-only integration.
