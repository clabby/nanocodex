const stores = new WeakMap();
const HEADER = "x-nanocodex-access";

/** Reuse finite-request authority across Agent handles for the same client identity. */
export function managedAccessFetch(fetchImpl, origin, identity = "browser") {
  let store = stores.get(fetchImpl);
  if (!store) stores.set(fetchImpl, store = new Map());
  const key = `${origin}\n${identity}`;
  let state = store.get(key);
  if (!state) {
    if (store.size >= 128) store.delete(store.keys().next().value);
    store.set(key, state = {});
  }
  const clock = () => performance.now();
  function remember(response, began) {
    const token = response.headers.get(HEADER);
    const ttl = Number(response.headers.get("x-nanocodex-access-ttl-ms"));
    if (response.ok && token?.startsWith("ncx_access_v1.") && token.length <= 16_384
      && Number.isFinite(ttl) && ttl > 0 && ttl <= 120_000) {
      const until = began + ttl;
      if (!state.until || until > state.until) { state.token = token; state.until = until; }
    }
  }
  return async (url, init = {}) => {
    const source = url instanceof Request ? url : undefined;
    const target = new URL(source?.url ?? url);
    const headers = new Headers(source?.headers ?? init.headers);
    headers.delete(HEADER);
    const eligible = target.origin === origin && /^\/v1\/agents(?:\/|$)/.test(target.pathname)
      && !headers.has("upgrade") && !headers.get("accept")?.includes("text/event-stream")
      && !/\/(?:ws|events|tool-host|device-host|sideband)$/.test(target.pathname);
    const token = eligible && state.until > clock() + 5000 ? state.token : undefined;
    if (token) headers.set(HEADER, token);
    const began = clock();
    const retryRequest = source && token ? source.clone() : undefined;
    let response;
    try {
      response = source ? await fetchImpl(new Request(source, { headers })) : await fetchImpl(url, { ...init, headers });
    } catch (error) {
      if (retryRequest?.body) void retryRequest.body.cancel().catch(() => {});
      throw error;
    }
    if (token && response.status === 401 && response.headers.get("x-nanocodex-access-rejected") === "1") {
      await response.body?.cancel();
      if (state.token === token) { state.token = undefined; state.until = undefined; }
      const retryHeaders = new Headers(headers);
      retryHeaders.delete(HEADER);
      // Rejected by ingress before admission. Preserve the exact body and idempotency key.
      response = retryRequest ? await fetchImpl(new Request(retryRequest, { headers: retryHeaders }))
        : await fetchImpl(url, { ...init, headers: retryHeaders });
    }
    if (retryRequest?.body && !retryRequest.bodyUsed) void retryRequest.body.cancel().catch(() => {});
    remember(response, began);
    return response;
  };
}

/** Wrap a managed HTTP transport with bounded, credential-bound access reuse. */
export function withManagedAccess(fetchImpl) {
  return (input, init) => {
    const request = new Request(input, init);
    const identity = JSON.stringify([...request.headers].filter(([name]) =>
      name === "authorization" || name === "cookie" || name.startsWith("x-nanocodex-connect-")).sort());
    return managedAccessFetch(fetchImpl, new URL(request.url).origin, identity)(request);
  };
}
