/** Owner-held grants and recipient-held references. Bearer secrets are never stored. */
export type HandShare = { id: string; machine_id: string; created_at: number; revoked_at: number | null };
export type ReceivedHandShare = { id: string; owner_id: string };
export type SharedHandRoute = { share_id: string; name: string; route_token: string };
export class HandShareStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS hand_shared_turn_targets (
      session_id TEXT, turn_id TEXT, owner_id TEXT, region TEXT, remote_session_id TEXT,
      PRIMARY KEY(session_id, turn_id, owner_id, region)
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS hand_shares (
      id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, revoked_at INTEGER
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS hand_share_members (
      share_id TEXT NOT NULL, recipient_id TEXT NOT NULL, PRIMARY KEY(share_id, recipient_id)
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS received_hand_shares (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS hand_share_routes (
      id TEXT PRIMARY KEY, share_id TEXT NOT NULL, name TEXT NOT NULL, route_token TEXT NOT NULL,
      UNIQUE(share_id, name, route_token)
    )`);
  }
  async create(machineId: string): Promise<(HandShare & { token: string }) | undefined> {
    const token = "nhs_" + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hash = await tokenHash(token);
    if (this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM hand_shares").toArray()[0]!.count >= 1000
      || this.list().length >= 100) return undefined;
    const share: HandShare = { id: crypto.randomUUID(), machine_id: machineId, created_at: Date.now(), revoked_at: null };
    this.storage.sql.exec("INSERT INTO hand_shares VALUES (?, ?, ?, ?, NULL)", share.id, machineId, hash, share.created_at);
    return { ...share, token };
  }
  list(): HandShare[] {
    return this.storage.sql.exec<HandShare>("SELECT id, machine_id, created_at, revoked_at FROM hand_shares WHERE revoked_at IS NULL ORDER BY created_at DESC").toArray();
  }
  revoke(id: string): boolean {
    const exists = this.storage.sql.exec("SELECT id FROM hand_shares WHERE id = ?", id).toArray().length > 0;
    if (exists) this.storage.sql.exec("UPDATE hand_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", Date.now(), id);
    return exists;
  }
  async redeem(recipientId: string, token: string): Promise<HandShare | undefined> {
    if (typeof token !== "string" || !/^nhs_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const hash = await tokenHash(token);
    const share = this.storage.sql.exec<HandShare>("SELECT id, machine_id, created_at, revoked_at FROM hand_shares WHERE token_hash = ? AND revoked_at IS NULL", hash).toArray()[0];
    if (share && !this.grant(share.id, recipientId) && this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM hand_share_members WHERE share_id = ?", share.id).toArray()[0]!.count >= 1000) return undefined;
    if (share) this.storage.sql.exec("INSERT OR IGNORE INTO hand_share_members VALUES (?, ?)", share.id, recipientId);
    return share;
  }
  grant(id: string, recipientId: string, includeRevoked = false): HandShare | undefined {
    return this.storage.sql.exec<HandShare>(`SELECT s.id, s.machine_id, s.created_at, s.revoked_at FROM hand_shares s
      JOIN hand_share_members m ON m.share_id = s.id WHERE s.id = ? AND m.recipient_id = ? AND (? = 1 OR s.revoked_at IS NULL)`, id, recipientId, includeRevoked ? 1 : 0).toArray()[0];
  }
  forgetReceived(id: string): void { this.storage.sql.exec("DELETE FROM received_hand_shares WHERE id = ?", id); }
  revokeMachine(machineId: string): void {
    this.storage.sql.exec("UPDATE hand_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE machine_id = ?", Date.now(), machineId);
  }
  turnTarget(session: string, turn: string | undefined, owner: string, region: string, remoteSession: string): void {
    if (turn === undefined) return;
    this.storage.sql.exec("INSERT OR IGNORE INTO hand_shared_turn_targets VALUES (?, ?, ?, ?, ?)", session, turn, owner, region, remoteSession);
  }
  turnTargets(session: string, turn: string) {
    return this.storage.sql.exec<{owner_id:string; region:string; remote_session_id:string}>(
      "SELECT owner_id,region,remote_session_id FROM hand_shared_turn_targets WHERE session_id=? AND turn_id=?", session, turn).toArray();
  }
  clearTurn(session: string, turn: string): void { this.storage.sql.exec("DELETE FROM hand_shared_turn_targets WHERE session_id=? AND turn_id=?", session, turn); }
  canReceive(): boolean { return this.received().length < 100; }
  receive(id: string, ownerId: string): boolean {
    if (!this.received().some(share => share.id === id) && !this.canReceive()) return false;
    this.storage.sql.exec("INSERT OR IGNORE INTO received_hand_shares VALUES (?, ?)", id, ownerId);
    return true;
  }
  received(): ReceivedHandShare[] {
    return this.storage.sql.exec<ReceivedHandShare>("SELECT id, owner_id FROM received_hand_shares").toArray();
  }
  route(shareId: string, name: string, routeToken: string): string {
    const existing = this.storage.sql.exec<{ id: string }>("SELECT id FROM hand_share_routes WHERE share_id = ? AND name = ? AND route_token = ?", shareId, name, routeToken).toArray()[0];
    if (existing) return `shared:v1:${shareId}:${existing.id}`;
    if (this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM hand_share_routes WHERE share_id = ?", shareId).toArray()[0]!.count >= 10000) {
      throw new Error("Shared Hand route capacity reached; create a new share");
    }
    this.storage.sql.exec("INSERT OR IGNORE INTO hand_share_routes VALUES (?, ?, ?, ?)", crypto.randomUUID(), shareId, name, routeToken);
    const row = this.storage.sql.exec<{ id: string }>("SELECT id FROM hand_share_routes WHERE share_id = ? AND name = ? AND route_token = ?", shareId, name, routeToken).toArray()[0]!;
    return `shared:v1:${shareId}:${row.id}`;
  }
  resolve(token: string): SharedHandRoute | undefined {
    const parsed = /^shared:v1:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(token);
    if (!parsed) return undefined;
    return this.storage.sql.exec<SharedHandRoute>("SELECT share_id, name, route_token FROM hand_share_routes WHERE id = ? AND share_id = ?", parsed[2]!, parsed[1]!).toArray()[0];
  }
}
async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
