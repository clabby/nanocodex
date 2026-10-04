import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { enrollCloudflare } from "../../../scripts/cloudflare/enroll-credential.mjs";

const token = "synthetic-cloudflare-token";
const operation = "ed16947a-d950-4d22-b37a-0c100a3ade80";
const transport = { fetch: (url: string, init?: RequestInit) => SELF.fetch(url, init) };

async function metadata(owner: string) {
  return (await SELF.fetch(`https://broker.internal/users/${owner}/credentials/vault`)).json<{ vault: unknown[] }>();
}

describe("Native Cloudflare enrollment through the private broker", () => {
  it("enrolls once, recovers from a lost response, and preserves existing auth on failed enrollment", async () => {
    const owner = "cloudflare-native-enrollment";
    const receipt = await enrollCloudflare(transport, { owner, operation, token });
    expect(receipt).toMatchObject({ status: "connected" });
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect((await metadata(owner)).vault).toHaveLength(1);
    // A repeat operation reconciles the saved Vault entry, rather than storing another copy.
    expect(await enrollCloudflare(transport, { owner, operation, token })).toEqual(receipt);
    expect((await metadata(owner)).vault).toHaveLength(1);
    await expect(enrollCloudflare(transport, {
      owner, operation: "bb451e10-66d9-4a0d-9674-3d42f6ac271a", token: "synthetic-invalid-token",
    })).rejects.toMatchObject({ code: "connect_rejected", status: 409 });
    const status = await (await SELF.fetch(`https://broker.internal/users/${owner}/connectors`)).json<any>();
    expect(status.connectors.cloudflare.connected).toBe(true);
    expect(status.connectors.cloudflare.connections).toHaveLength(1);
    expect(status.connectors.cloudflare.connections[0].id).toBe(receipt.connection_id);

    const recoveryOwner = "cloudflare-native-enrollment-recovery";
    let posts = 0;
    // Fault only the return transport after the real workerd Vault transaction succeeds.
    const droppedResponse = { async fetch(url: string, init?: RequestInit) {
      const response = await SELF.fetch(url, init);
      if (init?.method === "POST") { posts++; throw new Error(token); }
      return response;
    } };
    await expect(enrollCloudflare(droppedResponse, { owner: recoveryOwner, operation, token }))
      .rejects.toMatchObject({ code: "vault_create_outcome_unknown" });
    expect(posts).toBe(1);
    expect((await metadata(recoveryOwner)).vault).toHaveLength(1);
    expect(await enrollCloudflare(transport, { owner: recoveryOwner, operation, token }))
      .toMatchObject({ status: "connected" });
    expect((await metadata(recoveryOwner)).vault).toHaveLength(1);
  });

  it("enrolls an account-owned deployment token with its explicit account ID", async () => {
    const receipt = await enrollCloudflare(transport, {
      owner: "account-owned-enrollment", operation, token: "synthetic-cloudflare-account-token", accountId: "d".repeat(32),
    });
    expect(receipt.status).toBe("connected");
    expect((await metadata("account-owned-enrollment")).vault).toHaveLength(1);
  });

  it("rejects malformed owner and operation before transmitting credentials", async () => {
    await expect(enrollCloudflare(transport, { owner: "../foreign", operation, token }))
      .rejects.toMatchObject({ code: "invalid_owner" });
    await expect(enrollCloudflare(transport, { owner: "synthetic-owner", operation: "not-a-uuid", token }))
      .rejects.toMatchObject({ code: "invalid_operation" });
  });
});
