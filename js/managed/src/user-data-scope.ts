import { DurableObject } from "cloudflare:workers";
import {
  UserDataError,
  parseUserDataOperation,
  readUserDataRequest,
  MAX_USER_DATA_OBJECT_BYTES,
  type JsonValue,
  type UserDataOperation,
  type UserDataPoint,
  type UserDataTimeseriesAggregate,
  type UserDataTimeseriesQuery,
} from "nanocodex-tools/user-data";

const USER_ASSERTION = "x-nanocodex-user-id";
const OBJECT_GC_DELAY_MS = 60 * 60 * 1000;
const MAX_PAGE_BYTES = 1024 * 1024;

export interface UserDataScopeEnv {
  NANOCODEX_USER_DATA: DurableObjectNamespace;
  NANOCODEX_USER_DATA_OBJECTS: R2Bucket;
}

type DocumentRow = {
  key: string;
  value_json: string;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type PointRow = {
  timestamp_ms: number;
  value: number;
  fields_json: string;
  updated_at_ms: number;
};

type AggregateRow = {
  bucket: number;
  value: number;
  count: number;
};

type SeriesRow = {
  series: string;
  points: number;
  first_timestamp_ms: number;
  last_timestamp_ms: number;
};

type ObjectRow = {
  key: string;
  version: number;
  r2_key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
};

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, {
  ...init,
  headers: { "cache-control": "no-store", ...init.headers },
});

/** One strongly isolated SQLite index per account, with opaque payloads in R2. */
export class UserDataScope extends DurableObject<UserDataScopeEnv> {
  #activeUploads = new Set<string>();
  constructor(ctx: DurableObjectState, env: UserDataScopeEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_data_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        user_id TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_data_versions (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE TABLE IF NOT EXISTS user_object_gc (
        r2_key TEXT PRIMARY KEY,
        due_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_documents (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_timeseries (
        series TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
        value REAL NOT NULL,
        fields_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (series, timestamp_ms)
      );
      CREATE INDEX IF NOT EXISTS user_timeseries_time
        ON user_timeseries (timestamp_ms, series);
      CREATE TABLE IF NOT EXISTS user_objects (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1),
        r2_key TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        content_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO user_data_versions (kind, key, version)
        SELECT 'document', key, version FROM user_documents;
      INSERT OR IGNORE INTO user_data_versions (kind, key, version)
        SELECT 'object', key, version FROM user_objects;
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const assertedUser = request.headers.get(USER_ASSERTION);
    if (assertedUser === null || assertedUser.length === 0 || assertedUser.length > 256
      || !this.env.NANOCODEX_USER_DATA.idFromName(assertedUser).equals(this.ctx.id)) {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "PUT" && url.pathname === "/initialize" && url.search === "") {
      return assertedUser === null
        ? json({ error: "not_found" }, { status: 404 })
        : this.#initialize(assertedUser);
    }
    if (assertedUser === null || assertedUser !== this.#userId()) {
      return json({ error: "not_found" }, { status: 404 });
    }
    if (request.method !== "POST" || url.pathname !== "/operations" || url.search !== "") {
      return json({ error: "not_found" }, { status: 404 });
    }
    try {
      const operation = parseUserDataOperation(await readUserDataRequest(request));
      return json(await this.#operation(assertedUser, operation));
    } catch (error) {
      if (error instanceof UserDataError) {
        const status = error.code === "not_found" ? 404
          : error.code === "conflict" ? 409
            : error.code === "object_too_large" || error.code === "payload_too_large" ? 413
              : 400;
        return json({ error: error.code, message: error.message }, { status });
      }
      console.error({ type: "user_data.request_failed", error: errorKind(error) });
      return json({ error: "user_data_failed", message: "data service is temporarily unavailable" }, { status: 500 });
    }
  }

  #initialize(userId: string): Response {
    const current = this.#userId();
    if (current !== undefined && current !== userId) return json({ error: "not_found" }, { status: 404 });
    if (current === undefined) {
      this.ctx.storage.sql.exec(
        "INSERT INTO user_data_state (singleton, user_id, created_at_ms) VALUES (1, ?, ?)",
        userId,
        Date.now(),
      );
    }
    return new Response(null, { status: 204 });
  }

  #userId(): string | undefined {
    return this.ctx.storage.sql.exec<{ user_id: string }>(
      "SELECT user_id FROM user_data_state WHERE singleton = 1",
    ).toArray()[0]?.user_id;
  }

  async #operation(userId: string, operation: UserDataOperation): Promise<unknown> {
    switch (operation.operation) {
      case "document_put": return this.#putDocument(operation.key, operation.value, operation.if_version);
      case "document_get": return { operation: "document_get", document: this.#document(operation.key) };
      case "document_delete": return this.#deleteDocument(operation.key, operation.if_version);
      case "document_list": return this.#listDocuments(operation.prefix, operation.cursor, operation.limit);
      case "timeseries_list": return this.#listTimeseries(operation.prefix, operation.cursor, operation.limit);
      case "timeseries_write": return this.#writeTimeseries(
        operation.series,
        operation.points,
        operation.conflict,
      );
      case "timeseries_query": return this.#queryTimeseries(operation);
      case "timeseries_aggregate": return this.#aggregateTimeseries(operation);
      case "object_put": return this.#putObject(userId, operation);
      case "object_get": return this.#getObject(operation.key, operation.encoding);
      case "object_delete": return this.#deleteObject(operation.key, operation.if_version);
      case "object_list": return this.#listObjects(operation.prefix, operation.cursor, operation.limit);
    }
  }

  #putDocument(key: string, value: JsonValue, ifVersion?: number): unknown {
    const encoded = stableJson(value);
    const now = Date.now();
    let result!: ReturnType<typeof documentView> & { unchanged: boolean };
    this.ctx.storage.transactionSync(() => {
      const current = this.#documentRow(key);
      if (ifVersion !== undefined && current?.version !== ifVersion) conflict(key, current?.version);
      if (current?.value_json === encoded) {
        result = { ...documentView(current), unchanged: true };
        return;
      }
      const version = this.#nextVersion("document", key);
      this.ctx.storage.sql.exec(
        `INSERT INTO user_documents (key, value_json, version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           version = excluded.version,
           updated_at_ms = excluded.updated_at_ms`,
        key,
        encoded,
        version,
        current?.created_at_ms ?? now,
        now,
      );
      result = {
        key,
        value,
        version,
        created_at_ms: current?.created_at_ms ?? now,
        updated_at_ms: now,
        unchanged: false,
      };
    });
    return { operation: "document_put", document: result };
  }

  #document(key: string): ReturnType<typeof documentView> {
    const row = this.#documentRow(key);
    if (!row) throw new UserDataError("not_found", `document ${key} was not found`);
    return documentView(row);
  }

  #documentRow(key: string): DocumentRow | undefined {
    return this.ctx.storage.sql.exec<DocumentRow>(
      `SELECT key, value_json, version, created_at_ms, updated_at_ms
       FROM user_documents WHERE key = ?`,
      key,
    ).toArray()[0];
  }

  #deleteDocument(key: string, ifVersion?: number): unknown {
    let deleted!: ReturnType<typeof documentView>;
    this.ctx.storage.transactionSync(() => {
      const current = this.#documentRow(key);
      if (!current) throw new UserDataError("not_found", `document ${key} was not found`);
      if (ifVersion !== undefined && current.version !== ifVersion) conflict(key, current.version);
      this.ctx.storage.sql.exec("DELETE FROM user_documents WHERE key = ?", key);
      deleted = documentView(current);
    });
    return { operation: "document_delete", document: { key: deleted.key, version: deleted.version }, deleted: true };
  }

  #listDocuments(prefix: string | undefined, cursor: string | undefined, limit: number): unknown {
    const rows = this.ctx.storage.sql.exec<DocumentRow>(
      `SELECT key, value_json, version, created_at_ms, updated_at_ms
       FROM user_documents
       WHERE substr(key, 1, length(?)) = ? AND key > ?
       ORDER BY key ASC LIMIT ?`,
      prefix ?? "",
      prefix ?? "",
      cursor ?? "",
      limit + 1,
    );
    const { page, more } = boundedPage(rows, limit);
    return {
      operation: "document_list",
      documents: page.map(documentView),
      ...(more ? { next_cursor: page.at(-1)!.key } : {}),
    };
  }

  #writeTimeseries(
    series: string,
    points: readonly UserDataPoint[],
    mode: "error" | "replace",
  ): unknown {
    const unique = new Map<number, { value: number; fieldsJson: string }>();
    for (const point of points) {
      const candidate = { value: point.value, fieldsJson: stableJson(point.fields ?? {}) };
      const retained = unique.get(point.timestamp_ms);
      if (retained && (retained.value !== candidate.value || retained.fieldsJson !== candidate.fieldsJson)) {
        throw new UserDataError("conflict", `request contains conflicting points at ${point.timestamp_ms}`);
      }
      unique.set(point.timestamp_ms, candidate);
    }
    let inserted = 0;
    let replayed = 0;
    let replaced = 0;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const [timestamp, point] of unique) {
        const current = this.ctx.storage.sql.exec<Pick<PointRow, "value" | "fields_json">>(
          "SELECT value, fields_json FROM user_timeseries WHERE series = ? AND timestamp_ms = ?",
          series,
          timestamp,
        ).toArray()[0];
        if (current && current.value === point.value && current.fields_json === point.fieldsJson) {
          replayed += 1;
          continue;
        }
        if (current && mode === "error") {
          throw new UserDataError("conflict", `series ${series} already has another point at ${timestamp}`);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO user_timeseries (series, timestamp_ms, value, fields_json, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(series, timestamp_ms) DO UPDATE SET
             value = excluded.value,
             fields_json = excluded.fields_json,
             updated_at_ms = excluded.updated_at_ms`,
          series,
          timestamp,
          point.value,
          point.fieldsJson,
          now,
        );
        if (current) replaced += 1;
        else inserted += 1;
      }
    });
    return {
      operation: "timeseries_write",
      series,
      inserted,
      replayed,
      replaced,
    };
  }

  #listTimeseries(prefix: string | undefined, cursor: string | undefined, limit: number): unknown {
    const rows = this.ctx.storage.sql.exec<SeriesRow>(
      `SELECT series, COUNT(*) AS points, MIN(timestamp_ms) AS first_timestamp_ms,
              MAX(timestamp_ms) AS last_timestamp_ms
       FROM user_timeseries
       WHERE substr(series, 1, length(?)) = ? AND series > ?
       GROUP BY series ORDER BY series ASC LIMIT ?`,
      prefix ?? "",
      prefix ?? "",
      cursor ?? "",
      limit + 1,
    );
    const { page, more } = boundedPage(rows, limit);
    return {
      operation: "timeseries_list",
      series: page,
      ...(more ? { next_cursor: page.at(-1)!.series } : {}),
    };
  }

  #queryTimeseries(operation: UserDataTimeseriesQuery): unknown {
    const clauses = ["series = ?"];
    const values: (string | number)[] = [operation.series];
    if (operation.start_ms !== undefined) {
      clauses.push("timestamp_ms >= ?");
      values.push(operation.start_ms);
    }
    if (operation.end_ms !== undefined) {
      clauses.push("timestamp_ms <= ?");
      values.push(operation.end_ms);
    }
    if (operation.cursor !== undefined) {
      clauses.push(`timestamp_ms ${operation.order === "asc" ? ">" : "<"} ?`);
      values.push(Number(operation.cursor));
    }
    values.push(operation.limit + 1);
    const rows = this.ctx.storage.sql.exec<PointRow>(
      `SELECT timestamp_ms, value, fields_json, updated_at_ms
       FROM user_timeseries WHERE ${clauses.join(" AND ")}
       ORDER BY timestamp_ms ${operation.order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
      ...values,
    );
    const { page, more } = boundedPage(rows, operation.limit);
    return {
      operation: "timeseries_query",
      series: operation.series,
      points: page.map(pointView),
      ...(more ? { next_cursor: String(page.at(-1)!.timestamp_ms) } : {}),
    };
  }

  #aggregateTimeseries(operation: UserDataTimeseriesAggregate): unknown {
    const sqlFunction = operation.aggregation === "avg" ? "AVG(value)"
      : operation.aggregation === "min" ? "MIN(value)"
        : operation.aggregation === "max" ? "MAX(value)"
          : operation.aggregation === "sum" ? "SUM(value)"
            : "COUNT(*)";
    const rows = this.ctx.storage.sql.exec<AggregateRow>(
      `SELECT CAST((timestamp_ms - ?) / ? AS INTEGER) AS bucket,
              ${sqlFunction} AS value,
              COUNT(*) AS count
       FROM user_timeseries
       WHERE series = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
       GROUP BY bucket ORDER BY bucket ASC`,
      operation.start_ms,
      operation.bucket_ms,
      operation.series,
      operation.start_ms,
      operation.end_ms,
    ).toArray();
    if (rows.some(row => !Number.isFinite(row.value))) {
      throw new UserDataError("invalid_aggregation", "aggregation overflowed; reduce the input range or magnitude");
    }
    return {
      operation: "timeseries_aggregate",
      series: operation.series,
      aggregation: operation.aggregation,
      bucket_ms: operation.bucket_ms,
      buckets: rows.map((row) => ({
        start_ms: operation.start_ms + row.bucket * operation.bucket_ms,
        value: row.value,
        count: row.count,
      })),
    };
  }

  async #putObject(
    userId: string,
    operation: Extract<UserDataOperation, { operation: "object_put" }>,
  ): Promise<unknown> {
    const bytes = decodeContent(operation.content, operation.encoding);
    if (bytes.byteLength > MAX_USER_DATA_OBJECT_BYTES) {
      throw new UserDataError(
        "object_too_large",
        `JSON object uploads may not exceed ${MAX_USER_DATA_OBJECT_BYTES} decoded bytes`,
      );
    }
    const digest = await sha256(bytes);
    if (operation.sha256 !== undefined && operation.sha256 !== digest) {
      throw new UserDataError("digest_mismatch", "object content does not match sha256");
    }
    const metadataJson = stableJson(operation.metadata ?? {});
    const current = this.#objectRow(operation.key);
    if (operation.if_version !== undefined && current?.version !== operation.if_version) {
      conflict(operation.key, current?.version);
    }
    if (current?.sha256 === digest && current.content_type === operation.content_type
      && current.metadata_json === metadataJson) {
      return { operation: "object_put", object: { ...objectView(current), unchanged: true } };
    }
    const previousVersion = this.#lastVersion("object", operation.key);
    const r2Key = await objectStorageKey(userId, operation.key);
    // Register the upload before R2 I/O. A crash or lost compare-and-swap leaves
    // a durable cleanup entry; successful commits atomically remove it.
    // Arm cleanup before committing its index entry, so a crash cannot strand it.
    await this.#scheduleGc();
    this.#queueObjectGc(r2Key);
    this.#activeUploads.add(r2Key);
    try {
      await this.env.NANOCODEX_USER_DATA_OBJECTS.put(r2Key, bytes, {
        httpMetadata: { contentType: operation.content_type },
        customMetadata: { sha256: digest },
      });

      const now = Date.now();
      let stored!: ObjectRow;
      let unchanged = false;
      this.ctx.storage.transactionSync(() => {
        const latest = this.#objectRow(operation.key);
        if (operation.if_version !== undefined && latest?.version !== operation.if_version) {
          conflict(operation.key, latest?.version);
        }
        if (latest?.sha256 === digest && latest.content_type === operation.content_type
          && latest.metadata_json === metadataJson) {
          stored = latest;
          unchanged = true;
          return;
        }
        if (this.#lastVersion("object", operation.key) !== previousVersion
          || latest?.version !== current?.version) {
          throw new UserDataError("conflict", `object ${operation.key} changed while it was being uploaded`);
        }
        const version = this.#nextVersion("object", operation.key);
        this.ctx.storage.sql.exec(
          `INSERT INTO user_objects
             (key, version, r2_key, sha256, size_bytes, content_type, metadata_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             version = excluded.version,
             r2_key = excluded.r2_key,
             sha256 = excluded.sha256,
             size_bytes = excluded.size_bytes,
             content_type = excluded.content_type,
             metadata_json = excluded.metadata_json,
             updated_at_ms = excluded.updated_at_ms`,
          operation.key, version, r2Key, digest, bytes.byteLength,
          operation.content_type, metadataJson, latest?.created_at_ms ?? now, now,
        );
        this.ctx.storage.sql.exec("DELETE FROM user_object_gc WHERE r2_key = ?", r2Key);
        if (latest) this.#queueObjectGc(latest.r2_key);
        stored = {
          key: operation.key, version, r2_key: r2Key, sha256: digest,
          size_bytes: bytes.byteLength, content_type: operation.content_type,
          metadata_json: metadataJson, created_at_ms: latest?.created_at_ms ?? now,
          updated_at_ms: now,
        };
      });
      return { operation: "object_put", object: { ...objectView(stored), unchanged } };
    } finally { this.#activeUploads.delete(r2Key); }
  }

  async #getObject(key: string, encoding: "utf8" | "base64"): Promise<unknown> {
    const row = this.#objectRow(key);
    if (!row) throw new UserDataError("not_found", `object ${key} was not found`);
    const object = await this.env.NANOCODEX_USER_DATA_OBJECTS.get(row.r2_key);
    if (!object) throw new Error("retained object payload is missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = await sha256(bytes);
    if (digest !== row.sha256) throw new Error("retained object digest does not match its index");
    let content: string;
    if (encoding === "base64") content = encodeBase64(bytes);
    else {
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new UserDataError("invalid_encoding", "object is not valid UTF-8; request base64 encoding"); }
    }
    return { operation: "object_get", object: { ...objectView(row), encoding, content } };
  }

  async #deleteObject(key: string, ifVersion?: number): Promise<unknown> {
    await this.#scheduleGc();
    let row!: ObjectRow;
    this.ctx.storage.transactionSync(() => {
      const current = this.#objectRow(key);
      if (!current) throw new UserDataError("not_found", `object ${key} was not found`);
      if (ifVersion !== undefined && current.version !== ifVersion) conflict(key, current.version);
      this.ctx.storage.sql.exec("DELETE FROM user_objects WHERE key = ?", key);
      this.#queueObjectGc(current.r2_key);
      row = current;
    });
    return { operation: "object_delete", object: { key: row.key, version: row.version }, deleted: true };
  }

  #listObjects(prefix: string | undefined, cursor: string | undefined, limit: number): unknown {
    const rows = this.ctx.storage.sql.exec<ObjectRow>(
      `SELECT key, version, r2_key, sha256, size_bytes, content_type, metadata_json,
              created_at_ms, updated_at_ms
       FROM user_objects
       WHERE substr(key, 1, length(?)) = ? AND key > ?
       ORDER BY key ASC LIMIT ?`,
      prefix ?? "",
      prefix ?? "",
      cursor ?? "",
      limit + 1,
    );
    const { page, more } = boundedPage(rows, limit);
    return {
      operation: "object_list",
      objects: page.map(objectView),
      ...(more ? { next_cursor: page.at(-1)!.key } : {}),
    };
  }

  #lastVersion(kind: string, key: string): number {
    return this.ctx.storage.sql.exec<{ version: number }>(
      "SELECT version FROM user_data_versions WHERE kind = ? AND key = ?", kind, key,
    ).toArray()[0]?.version ?? 0;
  }

  #nextVersion(kind: string, key: string): number {
    const version = this.#lastVersion(kind, key) + 1;
    if (!Number.isSafeInteger(version)) throw new UserDataError("conflict", "version limit reached");
    this.ctx.storage.sql.exec(
      `INSERT INTO user_data_versions (kind, key, version) VALUES (?, ?, ?)
       ON CONFLICT(kind, key) DO UPDATE SET version = excluded.version`, kind, key, version,
    );
    return version;
  }

  #queueObjectGc(r2Key: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO user_object_gc (r2_key, due_at_ms) VALUES (?, ?)",
      r2Key, Date.now() + OBJECT_GC_DELAY_MS,
    );
  }

  async #scheduleGc(): Promise<void> {
    const due = this.ctx.storage.sql.exec<{ due: number | null }>(
      "SELECT MIN(due_at_ms) AS due FROM user_object_gc",
    ).toArray()[0]?.due;
    const scheduled = await this.ctx.storage.getAlarm();
    const next = Math.max(Date.now() + 60_000, due ?? Date.now() + OBJECT_GC_DELAY_MS);
    if (scheduled === null || scheduled > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ r2_key: string }>(
      "SELECT r2_key FROM user_object_gc WHERE due_at_ms <= ? ORDER BY due_at_ms LIMIT 100",
      Date.now(),
    ).toArray();
    try {
      for (const row of rows) {
        if (this.#activeUploads.has(row.r2_key)) {
          this.ctx.storage.sql.exec("UPDATE user_object_gc SET due_at_ms = ? WHERE r2_key = ?",
            Date.now() + OBJECT_GC_DELAY_MS, row.r2_key);
          continue;
        }
        await this.env.NANOCODEX_USER_DATA_OBJECTS.delete(row.r2_key);
        this.ctx.storage.sql.exec("DELETE FROM user_object_gc WHERE r2_key = ?", row.r2_key);
      }
    } finally {
      const pending = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM user_object_gc").toArray()[0]!.count;
      if (pending > 0) await this.#scheduleGc();
    }
  }

  #objectRow(key: string): ObjectRow | undefined {
    return this.ctx.storage.sql.exec<ObjectRow>(
      `SELECT key, version, r2_key, sha256, size_bytes, content_type, metadata_json,
              created_at_ms, updated_at_ms
       FROM user_objects WHERE key = ?`,
      key,
    ).toArray()[0];
  }
}

function documentView(row: DocumentRow) {
  return {
    key: row.key,
    value: JSON.parse(row.value_json) as JsonValue,
    version: row.version,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

function pointView(row: PointRow) {
  const fields = JSON.parse(row.fields_json) as Readonly<Record<string, JsonValue>>;
  return {
    timestamp_ms: row.timestamp_ms,
    value: row.value,
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    updated_at_ms: row.updated_at_ms,
  };
}

function objectView(row: ObjectRow) {
  return {
    key: row.key,
    version: row.version,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    content_type: row.content_type,
    metadata: JSON.parse(row.metadata_json) as Readonly<Record<string, JsonValue>>,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

function conflict(key: string, actual: number | undefined): never {
  throw new UserDataError(
    "conflict",
    actual === undefined ? `${key} does not exist at the requested version` : `${key} is at version ${actual}`,
  );
}

function boundedPage<T>(rows: Iterable<T>, limit: number): { page: T[]; more: boolean } {
  const page: T[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (page.length >= limit || (page.length > 0 && size + bytes > MAX_PAGE_BYTES)) {
      return { page, more: true };
    }
    page.push(row);
    size += bytes;
  }
  return { page, more: false };
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(content);
  try {
    if (content.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content)) throw new Error("invalid base64");
    const binary = atob(content);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new UserDataError("invalid_content", "object content is not valid base64");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(output);
}

async function objectStorageKey(userId: string, key: string): Promise<string> {
  const user = await sha256(new TextEncoder().encode(`nanocodex:user-data:v1\0${userId}`));
  const logicalKey = await sha256(new TextEncoder().encode(key));
  return `users/${user}/objects/${logicalKey}/${crypto.randomUUID()}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: JsonValue | Readonly<Record<string, JsonValue>>): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson((value as Readonly<Record<string, JsonValue>>)[key]!)}`
  )).join(",")}}`;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
