// Process-local monotonic anchors are deliberately never serialized across hosts.
const retryAnchors = new WeakMap();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Parse once at header receipt. Epoch milliseconds are portable across JS/WASM. */
export function retryAfterAdvice(value, receivedAt = Date.now(), receivedMonotonic = monotonicNow()) {
  if (typeof value !== "string" || !Number.isSafeInteger(receivedAt) || receivedAt < 0) return {};
  value = value.replace(/^[ \t]+|[ \t]+$/g, "");
  let seconds;
  let deadline;
  // Decimal seconds preserve existing host bridge compatibility; signs/exponents are not advice.
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    seconds = Number(value);
    const milliseconds = seconds * 1_000;
    if (!Number.isFinite(milliseconds) || milliseconds > Number.MAX_SAFE_INTEGER - receivedAt) return {};
    deadline = Math.ceil(receivedAt + milliseconds);
  } else {
    deadline = httpDate(value, receivedAt);
    if (deadline === undefined) return {};
    deadline = Math.max(0, deadline);
    seconds = Math.max(0, (deadline - receivedAt) / 1_000);
  }
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(deadline) || deadline < 0) return {};
  const advice = { retry_after: seconds, retry_after_deadline_ms: deadline };
  if (Number.isFinite(receivedMonotonic)) {
    retryAnchors.set(advice, { epoch: deadline, deadline: receivedMonotonic + Math.max(0, deadline - receivedAt) });
  }
  return advice;
}

/** Read an already-captured deadline, never restart it after body/observer work. */
export function retryAfterRemaining(advice, now = Date.now(), currentMonotonic = monotonicNow()) {
  const deadline = advice?.retry_after_deadline_ms;
  if (!Number.isSafeInteger(deadline) || deadline < 0) return undefined;
  const anchor = retryAnchors.get(advice);
  if (anchor?.epoch === deadline && Number.isFinite(currentMonotonic)) {
    return Math.max(0, anchor.deadline - currentMonotonic);
  }
  return Number.isSafeInteger(now) && now >= 0 ? Math.max(0, deadline - now) : undefined;
}

/** Transfer metadata and its process-local anchor when an error changes JS layers. */
export function attachRetryAfterAdvice(target, advice) {
  Object.assign(target, advice);
  const anchor = retryAnchors.get(advice);
  if (anchor?.epoch === advice.retry_after_deadline_ms) retryAnchors.set(target, anchor);
  return target;
}

function monotonicNow() {
  return globalThis.performance?.now();
}

function httpDate(value, receivedAt) {
  let match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  let weekday, day, monthName, year, hour, minute, second;
  if (match) {
    [, weekday, day, monthName, year, hour, minute, second] = match;
  } else {
    match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
    if (match) {
      [, weekday, day, monthName, year, hour, minute, second] = match;
      weekday = weekday.slice(0, 3);
      const currentYear = new Date(receivedAt).getUTCFullYear();
      year = Math.floor(currentYear / 100) * 100 + Number(year);
      const futureLimit = new Date(receivedAt);
      futureLimit.setUTCFullYear(currentYear + 50);
      if (Date.UTC(year, MONTHS.indexOf(monthName), Number(day), Number(hour), Number(minute), Number(second)) > futureLimit.getTime()) year -= 100;
    } else {
      match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
      if (!match) return undefined;
      [, weekday, monthName, day, hour, minute, second, year] = match;
    }
  }
  const month = MONTHS.indexOf(monthName);
  const deadline = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
  const date = new Date(deadline);
  // Date.parse alone accepts rollover dates, local zones and non-HTTP date syntax.
  if (Number(year) < 1601 || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== month || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second) || WEEKDAYS[date.getUTCDay()] !== weekday) return undefined;
  return deadline;
}
