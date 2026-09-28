import { HttpError } from "./Errors.mjs";

export const DEFAULT_API_URL = "https://api.nanocodex.xyz";

export function from(parameters) {
  if (!parameters || typeof parameters !== "object") {
    throw new TypeError("Transport.from requires parameters");
  }
  if (typeof parameters.setup !== "function") {
    throw new TypeError("Transport.from requires setup");
  }
  return Object.freeze({
    key: requiredString(parameters.key, "transport key"),
    name: requiredString(parameters.name, "transport name"),
    type: requiredString(parameters.type, "transport type"),
    setup: parameters.setup,
  });
}

export function http(url = DEFAULT_API_URL, options = {}) {
  const baseUrl = new URL(url).toString();
  const fetchFn = options.fetch ?? globalThis.fetch;
  const credentials = options.credentials ?? "include";
  if (typeof fetchFn !== "function") throw new TypeError("http transport requires fetch");
  return from({
    key: options.key ?? "http",
    name: options.name ?? "Nanocodex HTTP",
    type: "http",
    setup({ appId }) {
      return {
        baseUrl,
        fetch(input, init) {
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          headers.set("x-nanocodex-app-id", appId);
          return fetchFn(input, {
            ...init,
            headers,
            credentials: init?.credentials ?? credentials,
          });
        },
        async request(request) {
          const headers = new Headers(request.headers);
          headers.set("accept", "application/json");
          headers.set("x-nanocodex-app-id", appId);
          if (request.body !== undefined) headers.set("content-type", "application/json");
          const response = await fetchFn(new URL(request.path, baseUrl), {
            method: request.method ?? "GET",
            headers,
            credentials,
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: request.signal,
          });
          const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
          if (!response.ok) {
            throw new HttpError(
              response.status,
              body?.error?.message ?? `Nanocodex request failed with ${response.status}`,
              { code: body?.error?.code },
            );
          }
          return body;
        },
      };
    },
  });
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
