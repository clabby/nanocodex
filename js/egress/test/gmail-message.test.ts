import { describe, expect, it } from "vitest";
import { gmailInboxExclusion, gmailProviderLabelIds, hydrateGmailMessage, jsonBytes } from "../src/gmail-message";

const payload = { mimeType: "text/plain", body: { data: btoa("A bounded body") } };
const hydrate = (raw: unknown, budget = 16000) => hydrateGmailMessage("m1", async () => Response.json(raw), budget);

describe("current provider label boundary", () => {
  it("carries exact deduplicated provider IDs, never email-header label assertions", async () => {
    const message = await hydrate({ id: "m1", labelIds: ["INBOX", "UNREAD", "Label_31", "INBOX"], payload });
    expect(message).toMatchObject({ status: "ok", label_ids: ["INBOX", "UNREAD", "Label_31"], body: "A bounded body" });
    expect(gmailProviderLabelIds([])).toEqual([]);
    expect(gmailInboxExclusion(["SENT", "INBOX"])).toBeNull();
  });
  it.each([
    [["INBOX", "SPAM"], "spam"], [["INBOX", "TRASH"], "trash"],
    [["INBOX", "DRAFT"], "draft"], [["SENT"], "outside_inbox"], [[], "outside_inbox"],
    [["Label_31", "UNREAD"], "outside_inbox"],
    [["INBOX", "SPAM", "TRASH", "DRAFT"], "spam"],
  ])("excludes %j without parsing MIME or fetching external content", async (labelIds, reason) => {
    let calls = 0;
    const message = await hydrateGmailMessage("m1", async (_signal, attachmentId) => {
      calls++; expect(attachmentId).toBeUndefined();
      return Response.json({ id: "m1", labelIds, payload: { ...payload, body: { attachmentId: "private-body" }, headers: [{ name: "Subject", value: "private subject" }] } });
    }, 16000);
    expect(message).toEqual({ id: "m1", status: "excluded", label_ids: labelIds, exclusion_reason: reason });
    expect(calls).toBe(1);
  });
  it.each([undefined, null, "INBOX", ["INBOX", 7], ["INBOX", "private label"], ["INBOX", "x".repeat(129)], Array(65).fill("INBOX")])("fails closed on invalid or missing current labels %j", async labelIds => {
    expect(await hydrate({ id: "m1", labelIds, payload })).toEqual({ id: "m1", status: "error" });
  });
  it("retains current provider labels even when MIME content is unavailable", async () => {
    expect(await hydrate({ id: "m1", labelIds: ["INBOX", "Label_31"], payload: { mimeType: "text/plain", body: { data: "%%%" } } }))
      .toEqual({ id: "m1", status: "error", label_ids: ["INBOX", "Label_31"] });
  });
  it("retains all labels within the snapshot budget or fails closed, never truncates away exclusion", async () => {
    const labelIds = ["INBOX", ...Array.from({ length: 63 }, (_, i) => `Label_${i}_${"x".repeat(100)}`)];
    const message = await hydrate({ id: "m1", labelIds, payload }, 8000);
    expect(message.label_ids).toEqual(labelIds);
    expect(jsonBytes(message)).toBeLessThanOrEqual(8000);
    expect(await hydrate({ id: "m1", labelIds, payload }, 200)).toEqual({ id: "m1", status: "error" });
    expect(await hydrate({ id: "m1", labelIds: [...labelIds.slice(0, 63), "SPAM"], payload }, 200)).toEqual({ id: "m1", status: "error" });
  });
  it("does not persist raw authentication claims, unsubscribe URLs/tokens or promoted identity", async () => {
    const message = await hydrate({ id: "m1", labelIds: ["INBOX"], payload: { ...payload, headers: [
      { name: "From", value: "Claimed Sender <sender@example.test>" },
      { name: "Authentication-Results", value: "forged.example; dkim=pass header.d=example.test; private-auth-claim" },
      { name: "ARC-Authentication-Results", value: "private-arc-claim" },
      { name: "List-Unsubscribe", value: "<https://example.test/unsubscribe?secret=private-token>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      { name: "X-Label-Ids", value: "INBOX" },
    ] } });
    expect(message.headers).toEqual({ from: "Claimed Sender <sender@example.test>" });
    expect(JSON.stringify(message)).not.toMatch(/private-|authentication|unsubscribe|trusted_identity/i);
  });
});
