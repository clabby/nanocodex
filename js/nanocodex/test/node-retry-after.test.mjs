import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createNodeHost } from "../node/host.mjs";
import { retryAfterRemaining } from "../runtime/retry-after.mjs";

for (const format of ["numeric", "HTTP-date"]) {
  test(`real Node WS rejection captures ${format} advice before delayed body`, async () => {
    let deadline;
    const server = createServer((_request, response) => {
      deadline = Date.now() + 2_000;
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": format === "numeric" ? "2" : new Date(deadline).toUTCString(),
      });
      response.write('{"error":"');
      setTimeout(() => response.end('overloaded"}'), 300);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = createNodeHost();
    try {
      await assert.rejects(host.connect(`ws://127.0.0.1:${server.address().port}`, "synthetic", "018f1f9a-7b3c-7a01-8000-000000000001"), (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.body, '{"error":"overloaded"}');
        assert.equal(typeof error.retry_after_deadline_ms, "number");
        if (format === "numeric") {
          assert.ok(error.retry_after_deadline_ms >= deadline);
          assert.ok(error.retry_after_deadline_ms < deadline + 150, "deadline restarted after body read");
        } else {
          assert.equal(error.retry_after_deadline_ms, Math.floor(deadline / 1_000) * 1_000);
        }
        assert.ok(retryAfterRemaining(error) < 1_850, "body processing did not consume advice");
        return true;
      });
    } finally {
      await host.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
