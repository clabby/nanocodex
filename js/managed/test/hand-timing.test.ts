import { expect, it, vi } from "vitest";
import { beginHandTiming, finishHandTiming, recordHandTiming } from "../src/hand-timing";

it("redacts capability paths, queries, and credentials from Hand timing logs", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    for (const suffix of ["secret-pool/secret-allocation/hands/host", "secret-pool", "secret-pool/secret-allocation/secret-invalid"]) {
      const request = new Request(`https://example.com/v1/vm-host-attachments/${suffix}?secret-query`, {
        headers: { authorization: "Bearer secret-credential" },
      });
      beginHandTiming(request); recordHandTiming(request, "auth", 12);
      const response = finishHandTiming(request, new Response("ok", { headers: { "cache-control": "no-store" } }));
      expect(response.headers.get("server-timing")).toContain("hand_auth;dur=12.0");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-nanocodex-request-id")).toBeTruthy();
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-");
  } finally { log.mockRestore(); }
});
