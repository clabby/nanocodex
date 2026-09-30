use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use hkdf::Hkdf;
use nanocodex_secure_input_linux::*;
use p256::{
    PublicKey, SecretKey,
    ecdh::diffie_hellman,
    ecdsa::{
        Signature, SigningKey,
        signature::{Signer, Verifier},
    },
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand_core::OsRng;
use serde_json::json;
use sha2::Sha256;
fn command() -> Command {
    Command {
        executable: "/usr/bin/id".into(),
        arguments: vec!["-u".into()],
        cwd: "/".into(),
    }
}
fn setup() -> (Broker<()>, SigningKey, SigningKey) {
    let backend = SigningKey::random(&mut OsRng);
    let identity = SigningKey::random(&mut OsRng);
    (
        Broker::new(*backend.verifying_key(), identity.clone()),
        backend,
        identity,
    )
}
fn envelope(t: &Ticket, backend: &SigningKey, value: serde_json::Value) -> Envelope {
    let ephemeral = SecretKey::random(&mut OsRng);
    let recipient = PublicKey::from_sec1_bytes(&B64.decode(&t.public_key).unwrap()).unwrap();
    let shared = diffie_hellman(ephemeral.to_nonzero_scalar(), recipient.as_affine());
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.raw_secret_bytes())
        .expand(t.request_id.as_bytes(), &mut key)
        .unwrap();
    let nonce = [7u8; 12];
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let mut sealed = nonce.to_vec();
    sealed.extend(
        cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                serde_json::to_vec(&value).unwrap().as_slice(),
            )
            .unwrap(),
    );
    let mut e = Envelope {
        request_id: t.request_id.clone(),
        ephemeral_public_key: B64.encode(ephemeral.public_key().to_encoded_point(false).as_bytes()),
        ciphertext: B64.encode(sealed),
        signature: String::new(),
    };
    sign(&mut e, backend);
    e
}
fn sign(e: &mut Envelope, key: &SigningKey) {
    let sig: Signature = key.sign(&e.signing_data());
    e.signature = B64.encode(sig.to_bytes());
}
fn input(t: &Ticket) -> serde_json::Value {
    json!({"request_id":t.request_id,"command_digest":t.command_digest,"value":"only-test-input"})
}
#[test]
fn signed_wire_and_digest_binding() {
    let (mut b, _, identity) = setup();
    let t = b.prepare(command(), 1000, 1, ()).unwrap();
    let sig = Signature::from_slice(&B64.decode(&t.helper_signature).unwrap()).unwrap();
    assert!(
        identity
            .verifying_key()
            .verify(&t.signing_data(), &sig)
            .is_ok()
    );
    assert!(t.command_digest == command_digest(&command(), 1000).unwrap());
    assert!(t.command_digest != command_digest(&command(), 1001).unwrap());
    assert!(
        t.signing_data()
            .starts_with(b"nanocodex-secure-sudo-ticket-v1\n")
    );
    let wire = serde_json::to_string(&t).unwrap();
    assert!(!wire.contains("only-test-input"));
}
#[test]
fn valid_decrypt_dispatch_and_secret_free_receipt_one_use() {
    let (mut b, backend, _) = setup();
    let t = b.prepare(command(), 1000, 1, ()).unwrap();
    let e = envelope(&t, &backend, input(&t));
    let replay = envelope(&t, &backend, input(&t));
    let r = b
        .submit(e, 1000, 2, |c, uid, secret, ()| {
            assert!(c == &command());
            assert!(uid == 1000);
            assert!(secret == b"only-test-input");
            Ok(0)
        })
        .unwrap();
    let wire = serde_json::to_string(&r).unwrap();
    assert!(wire.contains("completed"));
    assert!(!wire.contains("only-test-input"));
    assert!(!wire.contains(&t.command_digest));
    assert!(
        b.submit(replay, 1000, 2, |_, _, _, ()| panic!("replay dispatched"))
            .is_err()
    );
}
#[test]
fn wrong_uid_and_wrong_signer_never_dispatch() {
    let (mut b, backend, _) = setup();
    let t = b.prepare(command(), 1000, 1, ()).unwrap();
    assert!(
        b.submit(
            envelope(&t, &backend, input(&t)),
            1001,
            2,
            |_, _, _, ()| panic!("UID dispatched")
        )
        .is_err()
    );
    let wrong = SigningKey::random(&mut OsRng);
    assert!(
        b.submit(
            envelope(&t, &wrong, input(&t)),
            1000,
            2,
            |_, _, _, ()| panic!("signer dispatched")
        )
        .is_err()
    );
    assert!(
        b.submit(
            envelope(&t, &backend, input(&t)),
            1000,
            2,
            |_, _, _, ()| Ok(0)
        )
        .is_ok()
    );
}
#[test]
fn expiry_cancel_and_restart_fail_closed() {
    let (mut b, backend, _) = setup();
    let t = b.prepare(command(), 1000, 1, ()).unwrap();
    assert!(
        b.submit(
            envelope(&t, &backend, input(&t)),
            1000,
            t.expires_at,
            |_, _, _, ()| panic!("expired dispatch")
        )
        .is_err()
    );
    let t = b.prepare(command(), 1000, 2, ()).unwrap();
    assert!(b.cancel(&t.request_id, 1001).is_err());
    assert!(b.cancel(&t.request_id, 1000).is_ok());
    assert!(
        b.submit(
            envelope(&t, &backend, input(&t)),
            1000,
            3,
            |_, _, _, ()| panic!("cancelled dispatch")
        )
        .is_err()
    );
    let (mut fresh, _, _) = setup();
    assert!(
        fresh
            .submit(
                envelope(&t, &backend, input(&t)),
                1000,
                3,
                |_, _, _, ()| panic!("restart dispatch")
            )
            .is_err()
    );
}
#[test]
fn signed_malformed_ciphertext_is_consumed_before_decrypt() {
    let (mut b, backend, _) = setup();
    let t = b.prepare(command(), 1000, 1, ()).unwrap();
    let mut e = envelope(&t, &backend, input(&t));
    e.ciphertext = "not-base64".into();
    sign(&mut e, &backend);
    assert!(
        b.submit(e, 1000, 2, |_, _, _, ()| panic!("malformed dispatch"))
            .is_err()
    );
    assert!(
        b.submit(
            envelope(&t, &backend, input(&t)),
            1000,
            2,
            |_, _, _, ()| panic!("consumed dispatch")
        )
        .is_err()
    );
}
#[test]
fn ciphertext_tamper_and_ephemeral_tamper_fail_authentication() {
    for what in 0..2 {
        let (mut b, backend, _) = setup();
        let t = b.prepare(command(), 1000, 1, ()).unwrap();
        let mut e = envelope(&t, &backend, input(&t));
        if what == 0 {
            let mut bytes = B64.decode(&e.ciphertext).unwrap();
            bytes[12] ^= 1;
            e.ciphertext = B64.encode(bytes);
        } else {
            e.ephemeral_public_key = B64.encode(
                SecretKey::random(&mut OsRng)
                    .public_key()
                    .to_encoded_point(false)
                    .as_bytes(),
            );
        }
        sign(&mut e, &backend);
        assert!(
            b.submit(e, 1000, 2, |_, _, _, ()| panic!("tampered dispatch"))
                .is_err()
        );
    }
}
#[test]
fn binding_controls_and_extra_plaintext_fields_rejected() {
    for kind in 0..6 {
        let (mut b, backend, _) = setup();
        let t = b.prepare(command(), 1000, 1, ()).unwrap();
        let mut value = input(&t);
        match kind {
            0 => value["request_id"] = json!("other"),
            1 => value["command_digest"] = json!("other"),
            2 => value["value"] = json!(""),
            3 => value["value"] = json!("x\ny"),
            4 => value["extra"] = json!(true),
            _ => value["value"] = json!("x".repeat(4097)),
        }
        assert!(
            b.submit(
                envelope(&t, &backend, value),
                1000,
                2,
                |_, _, _, ()| panic!("invalid plaintext dispatch")
            )
            .is_err()
        );
    }
}
#[test]
fn dispatch_failure_is_nonretryable_and_redacted() {
    let (mut b, backend, _) = setup();
    let t = b.prepare(command(), 1000, 1, ()).unwrap();
    let r = b
        .submit(envelope(&t, &backend, input(&t)), 1000, 2, |_, _, _, ()| {
            Err(Rejected)
        })
        .unwrap();
    assert!(r.status == "outcome_unknown" && r.exit_code.is_none());
    assert!(
        !serde_json::to_string(&r)
            .unwrap()
            .contains("only-test-input")
    );
    assert!(
        b.submit(
            envelope(&t, &backend, input(&t)),
            1000,
            2,
            |_, _, _, ()| panic!("failed retry")
        )
        .is_err()
    );
}
#[test]
fn unknown_request_fields_plaintext_and_multi_frames_rejected() {
    for value in [
        json!({"operation":"submit","request_id":"x","value":"only-test-input"}),
        json!({"operation":"cancel","request_id":"x","value":"only-test-input"}),
        json!({"operation":"prepare","executable":"/usr/bin/id","arguments":[],"cwd":"/","uid":1001}),
    ] {
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
    for wire in [
        b"{\"operation\":\"cancel\",\"request_id\":\"x\"}\n{}\n".to_vec(),
        vec![b'x'; MAX_FRAME + 1],
        b"{}".to_vec(),
        Vec::new(),
    ] {
        assert!(read_frame(wire.as_slice()).is_err());
    }
    assert!(read_frame(b"{\"operation\":\"cancel\",\"request_id\":\"x\"}\n".as_slice()).is_ok());
}
#[test]
fn caps_paths_and_canonical_base64() {
    let (mut b, _, _) = setup();
    assert!(b.prepare(command(), 0, 1, ()).is_err());
    for _ in 0..4 {
        assert!(b.prepare(command(), 1000, 1, ()).is_ok());
    }
    assert!(b.prepare(command(), 1000, 1, ()).is_err());
    for uid in 1001..1008 {
        for _ in 0..4 {
            assert!(b.prepare(command(), uid, 1, ()).is_ok());
        }
    }
    assert!(b.prepare(command(), 1008, 1, ()).is_err());
    let mut limiter = Admission::default();
    for _ in 0..24 {
        assert!(limiter.admit(1000));
    }
    assert!(!limiter.admit(1000));
    assert!(limiter.admit(1001));
    assert!(decode("YQ==", 1, 1).is_ok());
    assert!(decode("YR==", 1, 1).is_err());
    assert!(decode("YQ", 1, 1).is_err());
    assert!(!valid_path("relative"));
    assert!(!valid_path("/x\0"));
}

#[test]
fn every_ticket_signature_binding_rejects_mutation_or_wrong_helper_pin() {
    let (mut broker, _, identity) = setup();
    let ticket = broker.prepare(command(), 1000, 1, ()).unwrap();
    let sig = Signature::from_slice(&B64.decode(&ticket.helper_signature).unwrap()).unwrap();
    let wrong_helper = SigningKey::random(&mut OsRng);
    assert!(
        wrong_helper
            .verifying_key()
            .verify(&ticket.signing_data(), &sig)
            .is_err()
    );
    for field in 0..5 {
        let mut changed = ticket.clone();
        match field {
            0 => changed.request_id.push('x'),
            1 => changed.command_digest.push('x'),
            2 => changed.public_key.push('x'),
            3 => changed.expires_at += 1,
            _ => changed.uid = 998,
        }
        assert!(
            identity
                .verifying_key()
                .verify(&changed.signing_data(), &sig)
                .is_err()
        );
    }
    for field in 0..3 {
        let mut changed = command();
        match field {
            0 => changed.executable = "/usr/bin/true".into(),
            1 => changed.arguments.push("modified".into()),
            _ => changed.cwd = "/usr".into(),
        }
        assert!(command_digest(&changed, 1000).unwrap() != ticket.command_digest);
    }
}

#[test]
fn signed_invalid_points_and_nonce_tamper_consume_without_dispatch() {
    for field in 0..3 {
        let (mut broker, backend, _) = setup();
        let ticket = broker.prepare(command(), 1000, 1, ()).unwrap();
        let mut e = envelope(&ticket, &backend, input(&ticket));
        match field {
            0 => e.ephemeral_public_key = B64.encode([0u8; 65]),
            1 => e.ephemeral_public_key = B64.encode([4u8; 33]),
            _ => {
                let mut sealed = B64.decode(&e.ciphertext).unwrap();
                sealed[0] ^= 1;
                e.ciphertext = B64.encode(sealed);
            }
        }
        sign(&mut e, &backend);
        assert!(
            broker
                .submit(e, 1000, 2, |_, _, _, ()| panic!(
                    "invalid crypto dispatched"
                ))
                .is_err()
        );
        assert!(
            broker
                .submit(
                    envelope(&ticket, &backend, input(&ticket)),
                    1000,
                    2,
                    |_, _, _, ()| panic!("consumed ticket dispatched")
                )
                .is_err()
        );
    }
}

#[test]
fn bounded_arguments_overflow_and_global_rate_window() {
    let (mut broker, _, _) = setup();
    let mut oversized = command();
    oversized.arguments = vec!["x".into(); 129];
    assert!(broker.prepare(oversized, 1000, 1, ()).is_err());
    let mut oversized = command();
    oversized.arguments.push("x".repeat(4097));
    assert!(broker.prepare(oversized, 1000, 1, ()).is_err());
    let mut control = command();
    control.arguments.push("x\0".into());
    assert!(broker.prepare(control, 1000, 1, ()).is_err());
    assert!(broker.prepare(command(), 1000, u64::MAX, ()).is_err());
    let mut limiter = Admission::default();
    for uid in 1..=256 {
        assert!(limiter.admit(uid));
    }
    assert!(!limiter.admit(257));
}
