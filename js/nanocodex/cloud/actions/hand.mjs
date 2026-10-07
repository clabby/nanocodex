/** Every Hand this account still remembers, including offline registrations. */
export function list(client) {
  return client.request({ method: "GET", path: "/v1/account/hands/inventory" });
}

/**
 * Removes one Hand from the account. A Hand that is connected right now is
 * refused with `hand_online` unless `force` is set, so a mistyped identifier
 * cannot quietly cut a working machine loose.
 */
export function forget(client, id, options = {}) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new TypeError("A valid Hand id is required");
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Hand forget options must be an object");
  for (const key of Object.keys(options)) {
    if (key !== "force") throw new TypeError(`Unknown hand forget option: ${key}`);
  }
  if (options.force !== undefined && typeof options.force !== "boolean") throw new TypeError("force must be a boolean");
  const suffix = options.force ? "?force=1" : "";
  return client.request({
    method: "DELETE",
    path: `/v1/account/hands/${encodeURIComponent(id)}${suffix}`,
  });
}

/**
 * Removes every Hand observed definitively offline. Hands whose state could
 * not be determined stay registered; absence of evidence is not an eviction.
 */
export function prune(client) {
  return client.request({ method: "POST", path: "/v1/account/hands/prune" });
}
