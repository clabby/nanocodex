import { expect, it } from "vitest";
import { SpotifyReadCache } from "../src/spotify-read-cache";

it("bounds cached bodies and streams oversized responses without truncation", async () => {
  const cache = new SpotifyReadCache();
  const text = JSON.stringify({ value: "x".repeat(1024 * 1024 + 10) });
  const response = await cache.store("large", new Response(text, { headers: { "content-type": "application/json" } }));
  expect(await response.text()).toBe(text);
  expect(cache.get("large")).toBeUndefined();
  await cache.store("small", Response.json({ value: "ok" }));
  expect(await cache.get("small")!.json()).toEqual({ value: "ok" });
  await new Promise(resolve => setTimeout(resolve, 1_100));
  expect(cache.get("small")).toBeUndefined();
});

it("does not cache errors, separates accounts and headers, and normalizes query keys", async () => {
  const cache = new SpotifyReadCache();
  await cache.store("denied", Response.json({ error: "denied" }, { status: 403 }));
  expect(cache.get("denied")).toBeUndefined();
  const headers = new Headers({ accept: "application/json" });
  const first = cache.key("one", new URL("https://api.spotify.com/v1/me/playlists?offset=0&limit=20"), headers);
  expect(cache.key("one", new URL("https://api.spotify.com/v1/me/playlists?limit=20&offset=0"), headers)).toBe(first);
  expect(cache.key("two", new URL("https://api.spotify.com/v1/me/playlists?limit=20&offset=0"), headers)).not.toBe(first);
  expect(cache.key("one", new URL("https://api.spotify.com/v1/me/playlists?limit=20&offset=0"), new Headers({ "if-none-match": "tag" }))).not.toBe(first);
});
