import assert from "node:assert/strict";
import test from "node:test";
import { attachRetryAfterAdvice, retryAfterAdvice, retryAfterRemaining } from "../runtime/retry-after.mjs";

const RECEIVED = Date.UTC(2026, 8, 30, 20);
test("Retry-After accepts numeric seconds and safe epoch deadlines", () => {
  assert.deepEqual(retryAfterAdvice("2", RECEIVED), { retry_after: 2, retry_after_deadline_ms: RECEIVED + 2_000 });
  assert.deepEqual(retryAfterAdvice(" 0.125 ", RECEIVED), { retry_after: 0.125, retry_after_deadline_ms: RECEIVED + 125 });
  assert.equal(retryAfterAdvice("0", RECEIVED).retry_after_deadline_ms, RECEIVED);
});
test("Retry-After strict HTTP-date preserves expired advice", () => {
  assert.deepEqual(retryAfterAdvice("Wed, 30 Sep 2026 21:00:00 GMT", RECEIVED), {
    retry_after: 3_600, retry_after_deadline_ms: RECEIVED + 3_600_000,
  });
  const expired = retryAfterAdvice("Wed, 30 Sep 2026 19:00:00 GMT", RECEIVED, 100);
  assert.equal(expired.retry_after, 0);
  assert.equal(expired.retry_after_deadline_ms, RECEIVED - 3_600_000);
  assert.equal(retryAfterRemaining(expired, RECEIVED, 100), 0);
});
test("Retry-After rejects malformed, rollover, wrong weekday and unsafe values", () => {
  for (const value of [null, "", " ", "-1", "+2", "1e3", "0x10", "Infinity", "NaN", "1, 2", "9".repeat(400),
    "Wed, 31 Sep 2026 21:00:00 GMT", "Tue, 30 Sep 2026 21:00:00 GMT", "Wed, 30 Sep 2026 25:00:00 GMT",
    "Wed, 30 Sep 2026 21:00:00 UTC", "2026-09-30T21:00:00Z"]) {
    assert.deepEqual(retryAfterAdvice(value, RECEIVED), {}, String(value));
  }
  assert.deepEqual(retryAfterAdvice("1", Number.MAX_SAFE_INTEGER), {});
  assert.deepEqual(retryAfterAdvice("1", -1), {});
  assert.deepEqual(retryAfterAdvice("0.0001", Number.MAX_SAFE_INTEGER), {});
  assert.deepEqual(retryAfterAdvice("\n2", RECEIVED), {});
  assert.equal(retryAfterRemaining({ retry_after_deadline_ms: Infinity }, RECEIVED), undefined);
});
test("remaining advice subtracts body/observer time rather than restarting seconds", () => {
  const advice = retryAfterAdvice("2", RECEIVED, 100);
  assert.equal(retryAfterRemaining(advice, RECEIVED + 750, 850), 1_250);
  assert.equal(retryAfterRemaining(advice, RECEIVED + 2_500, 2_600), 0);
  assert.equal(retryAfterRemaining({}, RECEIVED), undefined);
});
test("strict obsolete HTTP-date forms remain compatible", () => {
  const deadline = Date.UTC(1994, 10, 6, 8, 49, 37);
  for (const date of ["Sunday, 06-Nov-94 08:49:37 GMT", "Sun Nov  6 08:49:37 1994"]) {
    assert.deepEqual(retryAfterAdvice(date, RECEIVED), { retry_after: 0, retry_after_deadline_ms: deadline });
  }
});

test("local retry anchors ignore forward/backward wall jumps and survive error wrapping", () => {
  const advice = retryAfterAdvice("2", RECEIVED, 100);
  const error = attachRetryAfterAdvice(new Error("overloaded"), advice);
  assert.equal(retryAfterRemaining(error, RECEIVED + 86_400_000, 850), 1_250);
  assert.equal(retryAfterRemaining(error, RECEIVED - 86_400_000, 850), 1_250);
  assert.equal(retryAfterRemaining(error, RECEIVED - 86_400_000, 2_100), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(advice)), { retry_after: 2, retry_after_deadline_ms: RECEIVED + 2_000 });
  // A serialized host/durable boundary intentionally reconstructs from epoch advice.
  assert.equal(retryAfterRemaining(JSON.parse(JSON.stringify(advice)), RECEIVED + 750, 900_000), 1_250);
});
