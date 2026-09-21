import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const python = process.env.NANOCODEX_CONNECTOR_SDK_PYTHON;

test("real Spotipy and Gmail SDKs read, paginate, write, and observe revocation", { skip: !python }, async t => {
  const outdir = await mkdtemp(path.join(os.tmpdir(), "nanocodex-spotipy-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await exec("npx", ["wrangler", "deploy", "--dry-run", "--config", "./wrangler.jsonc", "--outdir", outdir], { cwd: new URL("..", import.meta.url) });
  const worker = (await import(new URL(`file://${path.join(outdir, "index.js")}`))).default;
  const appOrigin = "https://nanocodex-connect-playground.gakonst.workers.dev";
  const grantId = `0x${"2".repeat(64)}`;
  const accountAddress = `0x${"1".repeat(40)}`;
  const connectionId = "a".repeat(43);
  const grant = {
    id: grantId, appId: "atlas-workspace", appOrigin, accountAddress, brokerUserId: accountAddress,
    agentId: "fixture-agent", permission: "agent.run", status: "active",
    expiresAt: Math.floor(Date.now() / 1000) + 600, capabilities: ["spotify", "gmail"],
    connectorConnections: { spotify: [connectionId], gmail: [connectionId] }, spentAtomics: "0",
    egressSubject: "s".repeat(43), sharedEgressSubject: true,
  };
  const forwarded = [];
  const env = {
    CONNECT_STATE: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({
      principal: { accountAddress, appId: grant.appId, appOrigin, grantId }, grant,
    }) }) },
    EGRESS: { fetch: async request => {
      assert.equal(request.headers.get("authorization"), "Bearer NANOCODEX_PROVIDER_CREDENTIAL");
      assert.equal(request.headers.get("x-nanocodex-connector-connection"), connectionId);
      const url = new URL(request.url);
      forwarded.push({ method: request.method, url: request.url, body: await request.text() });
      if (url.hostname === "gmail.googleapis.com") {
        if (request.method === "POST") return Response.json({ id: "message-1", labelIds: ["STARRED"] });
        return Response.json({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      if (request.method === "PUT") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("recently-played")) return Response.json({ error: { message: "Slow down" } }, { status: 429, headers: { "retry-after": "5" } });
      const second = url.searchParams.get("offset") === "1";
      return Response.json({ items: [{ name: second ? "Second" : "First" }],
        next: second ? null : "https://api.spotify.com/v1/me/playlists?limit=1&offset=1" });
    } },
  };
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/__test/revoke") { grant.status = "revoked"; outgoing.end(); return; }
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
        method: incoming.method, headers: incoming.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await worker.fetch(request, env, { waitUntil() {} });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const script = `
import importlib.util, sys, urllib.request
from spotipy.exceptions import SpotifyException
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials
spec = importlib.util.spec_from_file_location("example", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
client = module.spotify_client("t" * 43, origin=sys.argv[2])
page = client.current_user_playlists(limit=1)
assert page["items"][0]["name"] == "First"
assert page["next"].startswith(sys.argv[2] + "/connectors/spotify/")
assert client.next(page)["items"][0]["name"] == "Second"
client.playlist_change_details("fixture", name="SDK update")
try:
    client.current_user_recently_played(limit=1)
    raise AssertionError("expected rate limit")
except SpotifyException as error:
    assert error.http_status == 429
    assert error.headers["retry-after"] == "5"
gmail = build("gmail", "v1", credentials=Credentials(token="t" * 43),
              client_options={"api_endpoint": sys.argv[2] + "/connectors/gmail/"}, cache_discovery=False)
assert gmail.users().messages().list(userId="me").execute(num_retries=0)["messages"][0]["id"] == "message-1"
assert gmail.users().messages().modify(userId="me", id="message-1",
    body={"addLabelIds": ["STARRED"]}).execute(num_retries=0)["labelIds"] == ["STARRED"]
urllib.request.urlopen(sys.argv[2] + "/__test/revoke").close()
try:
    gmail.users().messages().list(userId="me").execute(num_retries=0)
    raise AssertionError("expected revoked Gmail grant")
except HttpError as error:
    assert error.resp.status == 409
try:
    client.current_user_playlists(limit=1)
    raise AssertionError("expected revoked grant")
except SpotifyException as error:
    assert error.http_status == 409
print("Spotipy: pagination, write, rate limit, revocation passed")
`;
  const result = await exec(python, ["-c", script,
    new URL("../../../examples/python/spotify_proxy.py", import.meta.url).pathname,
    `http://127.0.0.1:${server.address().port}`]);
  assert.match(result.stdout, /passed/);
  assert.equal(forwarded.length, 6, "no upstream call after revocation or automatic retry on 429");
  assert.equal(forwarded[1].url, "https://api.spotify.com/v1/me/playlists?limit=1&offset=1");
  assert.equal(forwarded[4].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages?alt=json");
  assert.equal(forwarded[5].method, "POST");
  assert.deepEqual(JSON.parse(forwarded[5].body), { addLabelIds: ["STARRED"] });
  assert.equal(forwarded[2].method, "PUT");
  assert.equal(JSON.parse(forwarded[2].body).name, "SDK update");
});
