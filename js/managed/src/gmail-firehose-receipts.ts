/** Additive receipt upgrade: keep personal-reply v1 dedupe and a distinct action lane. */
export function gmailDecisionReceipts(storage: DurableObjectStorage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS gmail_firehose_decision_receipts (
    source_key TEXT PRIMARY KEY, outcome TEXT NOT NULL CHECK (outcome IN ('reply','no_reply','filtered')), created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gmail_firehose_decision_receipts_v2 (
    source_key TEXT PRIMARY KEY, outcome TEXT NOT NULL CHECK (outcome IN ('reply','action_review','no_reply','filtered')), created_at INTEGER NOT NULL
  );
  INSERT INTO gmail_firehose_decision_receipts_v2(source_key,outcome,created_at)
    SELECT source_key,outcome,created_at FROM gmail_firehose_decision_receipts WHERE true ON CONFLICT(source_key) DO NOTHING;`);
  return {
    has: (sourceKey:string) => storage.sql.exec("SELECT source_key FROM gmail_firehose_decision_receipts_v2 WHERE source_key=?",sourceKey).toArray().length > 0,
    mark: (sourceKey:string,outcome:"reply" | "action_review" | "no_reply" | "filtered") => {
      storage.sql.exec("INSERT INTO gmail_firehose_decision_receipts_v2(source_key,outcome,created_at) VALUES(?,?,?) ON CONFLICT(source_key) DO NOTHING",sourceKey,outcome,Date.now());
    },
  };
}
