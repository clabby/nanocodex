/** Private account-service RPC. Gmail content supplies context, never authority. */
export type GmailPushWake = Readonly<{
  userId: string;
  agentId: string;
  eventId: string;
  input: string;
}>;
export type GmailPushWakeResult = Readonly<{
  status: "accepted" | "duplicate" | "busy";
  /** Private receipt: durable CRM progress; retry soon to finish processing. */
  progress?: true;
}>;

export function parseGmailPushWake(value: unknown): GmailPushWake {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_gmail_push_wake");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4
    || typeof row.userId !== "string" || !row.userId.trim() || row.userId.length > 256
    || typeof row.agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.agentId)
    || typeof row.eventId !== "string" || !row.eventId.trim() || row.eventId.length > 256
    || typeof row.input !== "string" || !row.input.trim() || new TextEncoder().encode(row.input).byteLength > 32_768) {
    throw new Error("invalid_gmail_push_wake");
  }
  return { userId: row.userId, agentId: row.agentId, eventId: row.eventId, input: row.input };
}
