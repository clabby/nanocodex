import { API_CONNECTORS } from "../internal.mjs";

const SERVICES = new Set(API_CONNECTORS);

/** Calls an opted-in service using the current app grant, without an agent turn. */
export async function request(client, options) {
  if (!SERVICES.has(options?.connector)) throw new TypeError("Unknown connector API");
  if (typeof options.path !== "string" || !options.path.startsWith("/") || options.path.startsWith("//")) {
    throw new TypeError("Connector requests require a provider-relative path");
  }
  return client.fetch(`/v1/connectors/${options.connector}/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: client.appOrigin },
    body: JSON.stringify({
      path: options.path,
      method: options.method ?? "GET",
      ...(options.connectionId === undefined ? {} : { connection_id: options.connectionId }),
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
    signal: options.signal,
  });
}
