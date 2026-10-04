// Private broker journey shared by the native runner and workerd transport tests.
export class EnrollmentFailure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateEnrollment({ owner, operation, token, accountId }, native = false) {
  if (typeof owner !== 'string' || !(native ? uuid : /^[A-Za-z0-9_-]{1,128}$/).test(owner)) throw new EnrollmentFailure('invalid_owner');
  if (typeof operation !== 'string' || !uuid.test(operation)) throw new EnrollmentFailure('invalid_operation');
  if (accountId !== undefined && (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId))) throw new EnrollmentFailure('invalid_account');
  if (typeof token !== 'string' || !token || token.length > 4096 || /\s/.test(token)) throw new EnrollmentFailure('invalid_token');
}
export async function enrollCloudflare(transport, input) {
  validateEnrollment(input);
  const { owner, operation, token } = input;
  const base = `https://broker.internal/users/${owner}`;
  const call = async (path, stage, body) => {
    let response;
    try {
      response = await transport.fetch(base + path, {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch { throw new EnrollmentFailure(body ? `${stage}_outcome_unknown` : `${stage}_unavailable`); }
    if (!response.ok) throw new EnrollmentFailure(`${stage}_rejected`, response.status);
    try { return await response.json(); }
    catch { throw new EnrollmentFailure(body ? `${stage}_outcome_unknown` : `${stage}_invalid_response`); }
  };
  // A caller must reuse this operation with identical inputs. The protected job
  // serializes enrollment; duplicate matching names fail closed on ambiguity.
  const name = `Cloudflare enrollment ${operation.toLowerCase()}`;
  const inventory = await call('/credentials/vault', 'vault_lookup');
  if (!Array.isArray(inventory?.vault)) throw new EnrollmentFailure('vault_lookup_invalid_response');
  const matches = inventory.vault.filter(entry => entry?.name === name);
  if (matches.length > 1 || matches.some(entry => entry.kind !== 'api_key')) throw new EnrollmentFailure('vault_lookup_ambiguous');
  const entry = matches[0] ?? await call('/credentials/vault/api_key', 'vault_create', { name, api_key: token });
  if (typeof entry?.id !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(entry.id)) throw new EnrollmentFailure('vault_create_outcome_unknown');
  // Connection IDs are stable for the token's provider identity. An explicit
  // rerun revalidates the saved Vault entry; no failed request is retried here.
  const connected = await call('/connectors/cloudflare', 'connect', { vault_id: entry.id, ...(input.accountId === undefined ? {} : { account_id: input.accountId }) });
  if (connected?.connected !== true || typeof connected.connection_id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(connected.connection_id)) throw new EnrollmentFailure('connect_outcome_unknown');
  const status = await call('/connectors', 'verify');
  if (status?.connectors?.cloudflare?.connected !== true || !status.connectors.cloudflare.connections?.some(entry => entry.id === connected.connection_id)) throw new EnrollmentFailure('verify_not_connected');
  return { status: 'connected', connection_id: connected.connection_id };
}
