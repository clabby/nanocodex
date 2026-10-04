/** Safe consent metadata. Decisions use the browser account cookie, never an API key. */
export type PermissionRequest = Readonly<{
  type: "permission_request";
  status: "pending" | "approved" | "denied" | "expired";
  request_id: string;
  key_id: string;
  capabilities: readonly string[];
  capability_descriptions: Readonly<Record<string, string>>;
  can_decide: boolean;
  reason: string;
  key_label: string;
  expires_at: number;
}>;
export type PermissionRequestReference = Readonly<{ requestId: string; keyId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{12}$/;
export function permissionRequestReference(url: URL): PermissionRequestReference | undefined {
  const requests = url.searchParams.getAll("permission_request");
  const keys = url.searchParams.getAll("key_id");
  if (requests.length !== 1 || keys.length !== 1 || !UUID.test(requests[0]!) || !KEY.test(keys[0]!)) return;
  return { requestId: requests[0]!, keyId: keys[0]! };
}
export async function readPermissionRequest(reference: PermissionRequestReference, signal?: AbortSignal): Promise<PermissionRequest> {
  return permissionRequest(reference, undefined, signal);
}
export async function decidePermissionRequest(reference: PermissionRequestReference, action: "approve" | "deny"): Promise<PermissionRequest> {
  const result = await permissionRequest(reference, action);
  if (result.status === "pending" || (action === "approve" && result.status === "denied") || (action === "deny" && result.status === "approved")) {
    throw new Error("The decision could not be confirmed. Check the request status.");
  }
  return result;
}
async function permissionRequest(reference: PermissionRequestReference, action?: "approve" | "deny", signal?: AbortSignal): Promise<PermissionRequest> {
  if (!UUID.test(reference.requestId) || !KEY.test(reference.keyId)) throw new Error("Invalid permission request link.");
  const response = await fetch(`/v1/permission-requests/${reference.keyId}/${reference.requestId}${action ? `/${action}` : ""}`, {
    method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    headers: { accept: "application/json", ...(action ? { "content-type": "application/json" } : {}) },
    ...(action ? { body: "{}" } : {}), signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 ? "Your account session has expired. Sign in to review this request."
      : response.status === 403 || response.status === 404 ? "This request is unavailable for this account. Check that you are signed in to the account that owns the API key."
      : "The permission request could not be confirmed. Check its status before trying again.");
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid permission request response.");
  const v = value as Record<string, unknown>;
  if (v.type !== "permission_request" || !["pending", "approved", "denied", "expired"].includes(String(v.status))
    || v.request_id !== reference.requestId || v.key_id !== reference.keyId
    || typeof v.reason !== "string" || v.reason.length > 4096 || typeof v.key_label !== "string" || v.key_label.length > 256
    || typeof v.expires_at !== "number" || !Number.isFinite(v.expires_at) || v.expires_at <= 0
    || !Array.isArray(v.capabilities) || v.capabilities.length > 32 || v.capabilities.length === 0
    || v.capabilities.some(c => typeof c !== "string" || !/^[a-z_]+:[a-z_]+$/.test(c) || c.length > 128)
    || typeof v.can_decide !== "boolean" || !v.capability_descriptions || typeof v.capability_descriptions !== "object" || Array.isArray(v.capability_descriptions)
    || new Set(v.capabilities).size !== v.capabilities.length) throw new Error("Invalid permission request response.");
  const descriptions = v.capability_descriptions as Record<string, unknown>;
  if (v.capabilities.some(c => !Object.hasOwn(descriptions, c) || typeof descriptions[c] !== "string" || !(descriptions[c] as string).trim() || (descriptions[c] as string).length > 4096)) {
    throw new Error("Invalid permission request response.");
  }
  return { type: "permission_request", status: v.status as PermissionRequest["status"], request_id: reference.requestId,
    key_id: reference.keyId, capabilities: v.capabilities as string[], can_decide: v.can_decide,
    capability_descriptions: Object.fromEntries(v.capabilities.map(c => [c, descriptions[c] as string])), reason: v.reason, key_label: v.key_label, expires_at: v.expires_at };
}
