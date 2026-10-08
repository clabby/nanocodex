/** One unconsumed auth-only upgrade, owned by a fresh Session activation. */
export class PreparedModelUpgrade {
  readonly #request: Request;
  readonly #abort = new AbortController();
  readonly #promise: Promise<Response | undefined>;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #started = Date.now();
  #response?: Response;
  #disposed = false;
  #claimed = false;
  #transferred = false;
  constructor(request: Request, binding: Pick<Fetcher, "fetch">) {
    this.#request = request;
    this.#timer = setTimeout(() => this.dispose("expired"), 10_000);
    // Invoke now: a microtask after Session initialization would be too late.
    let pending: Promise<Response>;
    try { pending = binding.fetch(new Request(request, { signal: this.#abort.signal })); }
    catch { pending = Promise.reject(new Error("Preparation unavailable")); }
    this.#promise = pending.then(response => {
      this.#response = response;
      if (this.#disposed || response.status !== 101 || !response.webSocket) {
        this.dispose("unavailable");
        return undefined;
      }
      this.#observe("connected");
      return response;
    }).catch(() => { this.dispose("failed"); return undefined; });
    this.#observe("started");
  }
  async take(request: Request, durable: () => Promise<void>, valid: () => boolean): Promise<Response | undefined> {
    if (!valid()) { this.dispose("stale"); throw new Error("Managed model preparation is no longer authorized"); }
    if (this.#claimed || this.#disposed) return undefined;
    if (request.method !== "GET" || request.url !== this.#request.url) return undefined;
    const headers = (value: Request) => JSON.stringify([...value.headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
    if (headers(request) !== headers(this.#request) || !valid()) {
      this.dispose("mismatch");
      return undefined;
    }
    this.#claimed = true;
    try {
      await durable();
      const response = await this.#promise;
      if (!valid()) { this.dispose("stale"); throw new Error("Managed model preparation is no longer authorized"); }
      if (!response || this.#disposed) { this.dispose("stale"); return undefined; }
      this.#transferred = true;
      clearTimeout(this.#timer);
      this.#observe("consumed");
      return response;
    } catch (error) { this.dispose("durability_failed"); throw error; }
  }
  dispose(outcome: string): void {
    if (this.#transferred) return;
    if (!this.#disposed) {
      this.#disposed = true;
      clearTimeout(this.#timer);
      this.#abort.abort();
      this.#observe(outcome);
    }
    // Also closes a response that arrived after cancellation. No frames are sent.
    const response = this.#response;
    this.#response = undefined;
    if (response?.webSocket) {
      try { response.webSocket.accept(); } catch { /* already accepted/closed */ }
      try { response.webSocket.close(1000, "Preparation ended"); } catch { /* disconnected */ }
    } else { void response?.body?.cancel().catch(() => {}); }
  }
  #observe(outcome: string): void {
    console.info({ type: "managed.model_upgrade_preparation", outcome, at_ms: Date.now(), elapsed_ms: Date.now() - this.#started });
  }
}
