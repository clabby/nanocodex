import { createHash } from "node:crypto";

export type SharePermission = "read" | "write";
type Link = { id: string; permission: SharePermission; created_at: number; revoked_at: number | null };
type LinkWithAuthorization = Link & { authorization_json: string | null };
const MAX_ACTIVE_LINKS = 20;
const tokenPattern = /^nsl_[A-Za-z0-9_-]{43}$/;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const bearerToken = (header: string | null) => header?.startsWith("Bearer ") && tokenPattern.test(header.slice(7))
  ? header.slice(7) : undefined;

/** Each thread's Durable Object is the sole authority for its links. */
export class ThreadShareLinks {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS managed_share_links (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        permission TEXT NOT NULL CHECK(permission IN ('read','write')),
        created_at INTEGER NOT NULL, revoked_at INTEGER, authorization_json TEXT
      );
      CREATE TABLE IF NOT EXISTS managed_share_turn_admissions (
        turn_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, admitted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_share_turn_admissions_window
        ON managed_share_turn_admissions(link_id, admitted_at);
    `);
    // Older links were comment-only. They do not acquire turn authority on upgrade.
    if (!storage.sql.exec<{ name: string }>("PRAGMA table_info(managed_share_links)").toArray()
      .some(column => column.name === "authorization_json")) {
      storage.sql.exec("ALTER TABLE managed_share_links ADD COLUMN authorization_json TEXT");
    }
  }

  create(permission: SharePermission, authorizationJson: string): (Link & { token: string }) | undefined {
    if (this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM managed_share_links WHERE revoked_at IS NULL").one().count >= MAX_ACTIVE_LINKS) return undefined;
    const token = `nsl_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const link: Link = { id: crypto.randomUUID(), permission, created_at: Date.now(), revoked_at: null };
    this.storage.sql.exec("INSERT INTO managed_share_links(id,token_hash,permission,created_at,authorization_json) VALUES(?,?,?,?,?)",
      link.id, tokenHash(token), permission, link.created_at, authorizationJson);
    return { ...link, token };
  }

  list(): Omit<Link, "revoked_at">[] {
    return this.storage.sql.exec<Omit<Link, "revoked_at">>(
      "SELECT id,permission,created_at FROM managed_share_links WHERE revoked_at IS NULL ORDER BY created_at,id",
    ).toArray();
  }

  revoke(id: string): boolean {
    return this.storage.sql.exec<{ id: string }>(
      "UPDATE managed_share_links SET revoked_at=? WHERE id=? AND revoked_at IS NULL RETURNING id", Date.now(), id,
    ).toArray().length > 0;
  }

  validate(header: string | null): LinkWithAuthorization | undefined {
    const token = bearerToken(header);
    if (!token) return undefined;
    return this.storage.sql.exec<LinkWithAuthorization>(
      "SELECT id,permission,created_at,revoked_at,authorization_json FROM managed_share_links WHERE token_hash=? AND revoked_at IS NULL",
      tokenHash(token),
    ).toArray()[0];
  }

  /** Called in the same transaction as durable turn admission. Revocation wins or admission wins.
   * Revoking does not cancel turns already admitted to the owner's thread. */
  admit(header: string | null, expectedLinkId: string, turnId: string, newTurn: boolean): "ok" | "revoked" | "rate_limited" {
    const link = this.validate(header);
    if (!link || link.id !== expectedLinkId) return "revoked";
    if (link.permission !== "write" || !link.authorization_json) return "revoked";
    if (!newTurn) return "ok";
    const now = Date.now();
    this.storage.sql.exec("DELETE FROM managed_share_turn_admissions WHERE admitted_at<?", now - 86_400_000);
    const minute = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM managed_share_turn_admissions WHERE link_id=? AND admitted_at>=?",
      link.id, now - 60_000,
    ).one().count;
    const hour = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM managed_share_turn_admissions WHERE link_id=? AND admitted_at>=?",
      link.id, now - 3_600_000,
    ).one().count;
    const allLinksHour = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM managed_share_turn_admissions WHERE admitted_at>=?", now - 3_600_000,
    ).one().count;
    if (minute >= 20 || hour >= 120 || allLinksHour >= 200) return "rate_limited";
    this.storage.sql.exec("INSERT INTO managed_share_turn_admissions(turn_id,link_id,admitted_at) VALUES(?,?,?)",
      turnId, link.id, now);
    return "ok";
  }

  clear(): void {
    this.storage.sql.exec("DELETE FROM managed_share_turn_admissions");
    // Legacy annotation rows must be removed before their link FK on old DOs.
    if (this.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_share_comments'",
    ).toArray().length > 0) this.storage.sql.exec("DELETE FROM managed_share_comments");
    this.storage.sql.exec("DELETE FROM managed_share_links");
  }
}
