import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { EgressEnv } from "../src/egress";
import { retryAfterMilliseconds } from "../src/spotify-rate-limit";
import { SPOTIFY_LOOPBACK_CLIENT_ID } from "../src/connectors/music";

const workerEnv = env as unknown as EgressEnv;
const origin = "https://api.spotify.com/v1/me/playlists";

afterEach(async () => {
  // Keep fixture quotas independent from OAuth tests using the same registration.
  for (const id of ["spotify-client-id", SPOTIFY_LOOPBACK_CLIENT_ID]) {
    const stub = workerEnv.SPOTIFY_RATE_LIMITS.getByName(id);
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAll());
    await evictDurableObject(stub);
  }
});

it("parses Spotify retry timing without accepting malformed or overflowing values", () => {
  const now = Date.UTC(2026, 8, 15);
  expect(retryAfterMilliseconds("5", now)).toBe(5_000);
  expect(retryAfterMilliseconds("0", now)).toBe(0);
  expect(retryAfterMilliseconds(new Date(now + 60_000).toUTCString(), now)).toBe(60_000);
  for (const value of [null, "invalid", "-1", "9".repeat(128)]) expect(retryAfterMilliseconds(value, now)).toBeUndefined();
});

it("persists one monotonic cooldown per registration across object eviction", async () => {
  const stub = workerEnv.SPOTIFY_RATE_LIMITS.getByName("durable-test-registration");
  const response = await stub.fetch("https://limit.test/cooldown", { method: "POST", headers: { "retry-after": "120" } });
  const { until } = await response.json<{ until: number }>();
  expect(until).toBeGreaterThan(Date.now() + 120_000);
  const shorter = await stub.fetch("https://limit.test/cooldown", { method: "POST", headers: { "retry-after": "1" } });
  expect((await shorter.json<{ until: number }>()).until).toBe(until);
  await evictDurableObject(stub);
  expect((await (await stub.fetch("https://limit.test/cooldown")).json<{ until: number }>()).until).toBe(until);
  const other = workerEnv.SPOTIFY_RATE_LIMITS.getByName("independent-test-registration");
  expect((await (await other.fetch("https://limit.test/cooldown")).json<{ until: number }>()).until).toBe(0);
});

it("shares duplicate reads across agent subjects, isolates identities, and invalidates after writes", async () => {
  const user = "rate-test-cache-owner";
  const alpha = await connect(user, "rate-test-alpha");
  const beta = await connect(user, "rate-test-beta");
  const subjects = ["R".repeat(43), "T".repeat(43)];
  for (const subject of subjects) await control(`/subjects/${subject}`, "PUT", { user_id: user });
  const read = (subject: string, id = alpha, suffix = "", extra = {}) => SELF.fetch(origin + suffix, {
    headers: { authorization: "Bearer NANOCODEX_PROVIDER_CREDENTIAL", "x-nanocodex-subject": subject,
      "x-nanocodex-connector-connection": id, ...extra },
  });
  const [first, second] = await Promise.all(subjects.map(subject => read(subject)));
  expect(await first.json()).toMatchObject({ calls: 1, account: "rate-test-alpha" });
  expect(await second.json()).toMatchObject({ calls: 1, account: "rate-test-alpha" });
  expect(await (await read(subjects[0]!, beta)).json()).toMatchObject({ calls: 1, account: "rate-test-beta" });
  expect(await (await read(subjects[0]!, alpha, "", { "if-none-match": '"different"' })).json()).toMatchObject({ calls: 2 });
  const broker = workerEnv.USER_CONNECTORS.getByName(user);
  const write = await broker.fetch(origin, { method: "POST", headers: {
    "x-nanocodex-connector-connection": alpha, "content-type": "application/json",
  }, body: '{"name":"update"}' });
  expect(await write.json()).toMatchObject({ calls: 3, method: "POST", body: '{"name":"update"}' });
  expect(await (await read(subjects[1]!)).json()).toMatchObject({ calls: 4 });
  await control(`/users/${user}/connectors/spotify/connections/${alpha}`, "DELETE");
  expect((await read(subjects[0]!)).status).toBe(404);
});

it("retries short read limits twice at most and never replays writes", async () => {
  const user = "rate-test-retry-owner";
  const connection = await connect(user, "rate-test-retry");
  const broker = workerEnv.USER_CONNECTORS.getByName(user);
  const headers = { "x-nanocodex-connector-connection": connection };
  const recovered = await broker.fetch(origin + "?case=retry&rate_limit=once", { headers });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ calls: 2 });
  const exhausted = await broker.fetch(origin + "?case=exhausted&rate_limit=always", { headers });
  expect(exhausted.status).toBe(429);
  expect(await exhausted.json()).toMatchObject({ calls: 3 });
  // Writes during a cooldown are rejected locally, never queued for later execution.
  const blocked = await broker.fetch(origin + "?case=write", { method: "POST", headers, body: "write" });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).not.toHaveProperty("calls");
  await new Promise(resolve => setTimeout(resolve, 1_100));
  const written = await broker.fetch(origin + "?case=write&rate_limit=once", { method: "POST", headers, body: "write" });
  expect(written.status).toBe(429);
  expect(await written.json()).toMatchObject({ calls: 1 });
});

it("a long app cooldown stops other users without sharing their responses or affecting another registration", async () => {
  const alphaUser = "rate-test-global-alpha";
  const betaUser = "rate-test-global-beta";
  const alpha = await connect(alphaUser, "rate-test-global-a");
  const beta = await connect(betaUser, "rate-test-global-b");
  const native = await connect(betaUser, "rate-test-global-native", true);
  const started = Date.now();
  const limited = await workerEnv.USER_CONNECTORS.getByName(alphaUser).fetch(origin + "?rate_limit=long", {
    headers: { "x-nanocodex-connector-connection": alpha },
  });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(120);
  expect(await limited.json()).toMatchObject({ calls: 1 });
  const other = await workerEnv.USER_CONNECTORS.getByName(betaUser).fetch(origin, {
    headers: { "x-nanocodex-connector-connection": beta },
  });
  expect(other.status).toBe(429);
  expect(await other.json()).not.toHaveProperty("account");
  expect(Date.now() - started).toBeLessThan(10_000);
  const unrelated = await workerEnv.USER_CONNECTORS.getByName(betaUser).fetch(origin, {
    headers: { "x-nanocodex-connector-connection": native },
  });
  expect(unrelated.status).toBe(200);
  expect(await unrelated.json()).toMatchObject({ calls: 1, account: "rate-test-global-native" });
  // Evicting the coordinator cannot bypass the shared cooldown.
  await evictDurableObject(workerEnv.SPOTIFY_RATE_LIMITS.getByName("spotify-client-id"));
  const afterEviction = await workerEnv.USER_CONNECTORS.getByName(betaUser).fetch(origin, {
    headers: { "x-nanocodex-connector-connection": beta },
  });
  expect(afterEviction.status).toBe(429);
});

it("uses a shared conservative cooldown when Spotify omits Retry-After", async () => {
  const user = "rate-test-missing-owner";
  const connection = await connect(user, "rate-test-missing");
  const broker = workerEnv.USER_CONNECTORS.getByName(user);
  const headers = { "x-nanocodex-connector-connection": connection };
  const response = await broker.fetch(origin + "?rate_limit=missing", { headers });
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(30);
  expect(await response.json()).toMatchObject({ calls: 1 });
  const next = await broker.fetch(origin, { headers });
  expect(next.status).toBe(429);
  expect(await next.json()).not.toHaveProperty("calls");
});

async function connect(user: string, account: string, loopback = false): Promise<string> {
  const path = `/users/${user}/connectors/spotify`;
  const flow = loopback ? { flow: "ncspot_loopback" } : {};
  const start = await control(path, "POST", { ...flow, redirect_uri: "https://nanocodex.test/v1/connectors/spotify/callback", return_to: "/profile" });
  expect(start.status).toBe(200);
  const url = new URL((await start.json<{ authorization_url: string }>()).authorization_url);
  const response = await control(path + "/callback", "POST", { ...flow, code: account, state: url.searchParams.get("state") });
  expect(response.status).toBe(200);
  return (await response.json<{ connection_id: string }>()).connection_id;
}

function control(path: string, method: string, body?: unknown) {
  return SELF.fetch(`https://broker.test${path}`, { method, ...(body === undefined ? {} : {
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) });
}
