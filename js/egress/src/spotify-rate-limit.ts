import { DurableObject } from "cloudflare:workers";

const COOLDOWN_KEY = "cooldown-until";
const MAX_READ_WAIT_MS = 10_000;
const MAX_READ_RETRIES = 2;

/** One object per OAuth client ID. Stores timing only, never accounts or tokens. */
export class SpotifyRateLimit extends DurableObject<unknown> {
  #until = 0;
  readonly #ready: Promise<void>;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.#ready = state.blockConcurrencyWhile(async () => {
      this.#until = await state.storage.get<number>(COOLDOWN_KEY) ?? 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    if (new URL(request.url).pathname !== "/cooldown") return new Response(null, { status: 404 });
    if (request.method === "POST") {
      // The caller copies only the provider's bounded Retry-After header.
      const retryAfter = request.headers.get("retry-after");
      const duration = retryAfterMilliseconds(retryAfter) ?? 30_000;
      const until = Date.now() + duration + 1_000;
      if (until > this.#until) {
        this.#until = until;
        await this.ctx.storage.put(COOLDOWN_KEY, this.#until);
        console.info(JSON.stringify({ event: "spotify_rate_limit", retry_after_seconds: Math.ceil((duration + 1_000) / 1_000) }));
      }
    } else if (request.method !== "GET") return new Response(null, { status: 405 });
    return Response.json({ until: this.#until }, { headers: { "cache-control": "no-store" } });
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.length > 128) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : undefined;
  const duration = seconds === undefined ? Date.parse(value) - now : seconds * 1_000;
  return Number.isFinite(duration) && duration >= 0 && Number.isSafeInteger(now + duration + 1_000)
    ? duration : undefined;
}

/** Reads retry briefly; all callers share the registration's durable cooldown. */
export async function spotifyFetch(request: Request, coordinator: DurableObjectStub<SpotifyRateLimit>): Promise<Response> {
  const deadline = Date.now() + MAX_READ_WAIT_MS;
  let previous: Response | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      request.signal.throwIfAborted();
      let until = await cooldown(coordinator);
      while (until > Date.now()) {
        if (request.method !== "GET" || until > deadline) {
          return limited(until, previous);
        }
        await sleep(until - Date.now(), request.signal);
        // Another user may have extended the shared cooldown while we waited.
        until = await cooldown(coordinator);
      }
      await previous?.body?.cancel();
      previous = undefined;
      request.signal.throwIfAborted();
      const response = await fetch(request.method === "GET" ? request.clone() : request, { redirect: "manual", signal: request.signal });
      if (response.status !== 429) return response;
      try {
        until = await cooldown(coordinator, response.headers.get("retry-after"));
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      if (request.method !== "GET" || attempt === MAX_READ_RETRIES || until > deadline) {
        return limited(until, response);
      }
      previous = response;
    }
  } catch (error) {
    await previous?.body?.cancel();
    throw error;
  }
}

async function cooldown(coordinator: DurableObjectStub<SpotifyRateLimit>, retryAfter?: string | null): Promise<number> {
  const response = await coordinator.fetch("https://spotify-limit.internal/cooldown", {
    method: retryAfter === undefined ? "GET" : "POST",
    ...(retryAfter === undefined || retryAfter === null ? {} : { headers: { "retry-after": retryAfter.slice(0, 128) } }),
  });
  if (!response.ok) throw new Error("Spotify cooldown unavailable");
  const value = await response.json<{ until?: unknown }>();
  if (typeof value.until !== "number" || !Number.isSafeInteger(value.until) || value.until < 0) {
    throw new Error("Invalid Spotify cooldown");
  }
  return value.until;
}

function limited(until: number, upstream?: Response): Response {
  const headers = new Headers(upstream?.headers);
  headers.set("retry-after", String(Math.max(1, Math.ceil((until - Date.now()) / 1_000))));
  headers.set("cache-control", "no-store");
  if (upstream) return new Response(upstream.body, { status: 429, headers });
  return Response.json({ error: { status: 429, message: "Spotify's shared app quota is cooling down. Wait Retry-After seconds before trying again." } }, { status: 429, headers });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
