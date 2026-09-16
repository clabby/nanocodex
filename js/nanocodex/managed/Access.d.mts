/** Reuses short-lived server-issued authorization for finite managed Agent HTTP requests.
 * Retains the original credential and scopes; retries once only on explicit pre-admission rejection.
 * Cache state is bounded, in memory, and separated by origin and credential/grant.
 */
export function withManagedAccess(fetch: typeof globalThis.fetch): typeof globalThis.fetch;
