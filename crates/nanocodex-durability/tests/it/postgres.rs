//! Runs against a real server when `NANOCODEX_POSTGRES_URL` is set, e.g.
//! `NANOCODEX_POSTGRES_URL="host=127.0.0.1 port=5432 user=postgres" \
//!  cargo test -p nanocodex-durability --features postgres --test it postgres`.

use nanocodex_durability::{OwnerId, PostgresStore, StateStore, StoreRecord};

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
    let owner = store.acquire(&state, OwnerId::new()).await.unwrap().owner;
    let records = [("a", "=1"), ("b", "=2")].map(|(key, value)| StoreRecord {
        key: key.into(),
        value: value.into(),
    });
    // Every revision round-trips through the NUMERIC column.
    assert_eq!(
        store.replace(&state, &owner, 0, "one", &records).await,
        Ok(1)
    );
    assert_eq!(store.replace(&state, &owner, 1, "two", &[]).await, Ok(2));
    let keys = ["b", "missing", "a", "b"].map(str::to_owned);
    assert_eq!(
        store.read_records(&state, &keys).await.unwrap(),
        [Some("=2"), None, Some("=1"), Some("=2")].map(|value| value.map(str::to_owned))
    );
}
