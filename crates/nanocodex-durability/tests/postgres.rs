//! Runs against a real server when `NANOCODEX_POSTGRES_URL` is set, e.g.
//! `NANOCODEX_POSTGRES_URL="host=127.0.0.1 port=5432 user=postgres" \
//!  cargo test -p nanocodex-durability --features postgres --test postgres`.
#![cfg(all(feature = "postgres", not(target_family = "wasm")))]

use nanocodex_durability::{OwnerId, PostgresStore, StateStore, StoreError, StoreRecord};

#[tokio::test]
async fn batched_records_and_revisions_round_trip() {
    let Ok(url) = std::env::var("NANOCODEX_POSTGRES_URL") else {
        eprintln!("NANOCODEX_POSTGRES_URL is unset; skipping the Postgres store check");
        return;
    };
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(connection);
    let mut store = PostgresStore::new(client).await.unwrap();
    let state = OwnerId::new().as_str().to_owned();
    let owned = store.acquire(&state, OwnerId::new()).await.unwrap();
    let record = |key: &str, value: &str| StoreRecord {
        key: key.into(),
        value: value.into(),
    };
    // Duplicate keys in one batch are idempotent, and a revision above one
    // must round-trip through the NUMERIC column.
    let records = [record("a", "=1"), record("b", "=2"), record("a", "=1")];
    assert_eq!(
        store
            .replace(&state, &owned.owner, 0, "one", &records)
            .await,
        Ok(1)
    );
    assert_eq!(
        store.replace(&state, &owned.owner, 1, "two", &[]).await,
        Ok(2)
    );
    let keys = ["b", "missing", "a", "b"].map(str::to_owned);
    assert_eq!(
        store.read_records(&state, &keys).await.unwrap(),
        [Some("=2"), None, Some("=1"), Some("=2")].map(|value| value.map(str::to_owned))
    );
    assert_eq!(
        store.replace(&state, &owned.owner, 1, "stale", &[]).await,
        Err(StoreError::Conflict {
            expected: 1,
            actual: 2
        })
    );
    let reacquired = store.acquire(&state, OwnerId::new()).await.unwrap();
    assert_eq!(reacquired.state.revision, 2);
    assert_eq!(reacquired.state.payload.as_deref(), Some("two"));
}
