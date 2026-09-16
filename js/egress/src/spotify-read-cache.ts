const TTL_MS = 1_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 8;

type CachedRead = { expires: number; bytes: Uint8Array; status: number; headers: [string, string][] };

/** Owned by one user broker, keyed by exact connection and representation. */
export class SpotifyReadCache {
  #entries = new Map<string, CachedRead>();

  clear(): void { this.#entries.clear(); }

  key(connectionId: string, url: URL, headers: Headers): string {
    const normalized = new URL(url);
    normalized.searchParams.sort();
    return JSON.stringify([connectionId, normalized.href, [...headers].filter(([name]) => name !== "authorization")]);
  }

  get(key: string): Response | undefined {
    this.#prune();
    const entry = this.#entries.get(key);
    return entry ? new Response(entry.bytes.slice(), { status: entry.status, headers: entry.headers }) : undefined;
  }

  async store(key: string, response: Response): Promise<Response> {
    if (response.status !== 200 || !response.body
      || !/\bapplication\/(?:[a-z0-9.-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        // Large reads still stream in full; only caching is bounded.
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
          async pull(controller) {
            const next = await reader.read();
            if (next.done) { reader.releaseLock(); controller.close(); }
            else controller.enqueue(next.value);
          },
          async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
        }), { status: response.status, headers: response.headers });
      }
    }
    reader.releaseLock();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.#prune();
    while (this.#entries.size >= MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    this.#entries.set(key, { bytes, status: response.status, headers: [...response.headers], expires: Date.now() + TTL_MS });
    return new Response(bytes.slice(), { status: response.status, headers: response.headers });
  }

  #prune(): void {
    for (const [key, value] of this.#entries) if (value.expires <= Date.now()) this.#entries.delete(key);
  }
}
