/** Internal Durable Object storage contract. Public requests never select a scope. */
export type AppThread = Readonly<{
  id: string;
  agent_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  deleted?: boolean;
}>;

type ThreadStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  list<T>(options: { prefix: string; startAfter?: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(operation: (storage: ThreadStorage) => Promise<T>): Promise<T>;
};

/** Runs on an internal, scope-named DO, using transactions for index consistency. */
export async function appThreadStorage(request: Request, storage: ThreadStorage): Promise<Response> {
  const body = await request.json() as { operation: string; operation_id?: string; id?: string; agent_id?: string; title?: string; cursor?: string; thread?: AppThread };
  return storage.transaction(async (txn) => {
    if (body.operation === "list") {
      const entries = await txn.list<AppThread>({ prefix: "thread:", limit: 101,
        ...(body.cursor ? { startAfter: `thread:${body.cursor}` } : {}) });
      const all = [...entries.values()];
      const page = all.slice(0, 100);
      return Response.json({ threads: page.filter(thread => !thread.deleted),
        ...(all.length > 100 ? { next_cursor: page.at(-1)!.id } : {}) });
    }
    if (body.operation === "begin_create") {
      const key = `operation:${body.operation_id}`;
      const pending = await txn.get<Omit<AppThread, "agent_id">>(key);
      if (pending && pending.title !== body.title) return new Response(null, { status: 409 });
      if (pending) {
        const published = await txn.get<AppThread>(`thread:${pending.id}`);
        if (published?.deleted) return new Response(null, { status: 410 });
        // An existing reservation may already have reached the managed service.
        // A retry only reads its receipt; it never dispatches creation again.
        return published ? Response.json(published) : new Response(null, { status: 425 });
      }
      const now = Date.now();
      const reserved = { id: crypto.randomUUID(), title: body.title!, created_at: now, updated_at: now };
      // Persist the dispatch fence before contacting the managed service.
      await txn.put(key, reserved);
      return Response.json(reserved);
    }
    if (body.operation === "create") {
      const thread = body.thread!;
      const pending = await txn.get<Omit<AppThread, "agent_id">>(`operation:${body.operation_id}`);
      if (!pending || pending.id !== thread.id || pending.title !== thread.title) return new Response(null, { status: 409 });
      const published = await txn.get<AppThread>(`thread:${thread.id}`);
      if (published?.deleted) return new Response(null, { status: 410 });
      if (published) return Response.json(published);
      await txn.put(`thread:${thread.id}`, thread);
      await txn.put(`agent:${thread.agent_id}`, thread.id);
      return Response.json(thread);
    }
    const id = body.operation === "agent" ? await txn.get<string>(`agent:${body.agent_id}`) : body.id;
    const thread = id ? await txn.get<AppThread>(`thread:${id}`) : undefined;
    if (!thread || (thread.deleted && body.operation !== "delete")) return new Response(null, { status: 404 });
    if (body.operation === "rename" || body.operation === "delete") {
      const updated = { ...thread, updated_at: Date.now(),
        ...(body.operation === "delete" ? { deleted: true, title: "" } : { title: body.title! }) };
      await txn.put(`thread:${thread.id}`, updated);
      return Response.json(updated);
    }
    return Response.json(thread);
  });
}
