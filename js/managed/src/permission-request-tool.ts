import type { NamedTool, ToolContext } from "nanocodex";
import type { OrganizationCapability } from "./account-auth";

export type PermissionToolInput =
  | Readonly<{ operation: "request"; operation_id: string; capabilities: OrganizationCapability[]; reason: string }>
  | Readonly<{ operation: "status"; request_id: string }>;

/** The model can propose or inspect a request. Only the private client UI decides it. */
export function permissionRequestTool(
  execute: (input: PermissionToolInput, context: ToolContext) => Promise<unknown>,
): NamedTool {
  return {
    name: "request_permissions",
    description: "Ask the signed-in user to approve missing account permissions for this login, or check an existing request. The user reviews the exact permissions in the private app or account page; this tool cannot approve them. Use one stable UUID operation_id and a brief reason for each request. Reuse the same ID and arguments after uncertainty. Return the approval_url as a clickable fallback. Pending is not approval: wait for the user's decision, then check status or retry on their next turn. Existing API-key sessions keep the same credential. Approval requires the owner's authenticated account page; API keys cannot approve their own expansion; Connect grants must renew their app consent. Root agent only.",
    parameters: {
      type: "object", additionalProperties: false, required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["request", "status"] },
        operation_id: { type: "string", description: "Stable request UUID; required for request." },
        request_id: { type: "string", description: "Existing request UUID; required for status." },
        capabilities: { type: "array", minItems: 1, maxItems: 9, uniqueItems: true, items: {
          type: "string", enum: ["agents:read", "agents:write", "agents:portability", "data:read", "data:write", "history:read", "memory:read", "memory:write", "tools:use"],
        } },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
      },
    },
    handler: async (input, context) => {
      context.signal.throwIfAborted();
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid permission request");
      const value = input as Record<string, unknown>;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (value.operation === "status") {
        if (Object.keys(value).some(key => key !== "operation" && key !== "request_id")
          || typeof value.request_id !== "string" || !uuid.test(value.request_id)) throw new TypeError("Invalid permission status request");
        return execute({ operation: "status", request_id: value.request_id }, context);
      }
      if (value.operation !== "request" || Object.keys(value).some(key => !["operation", "operation_id", "capabilities", "reason"].includes(key))
        || typeof value.operation_id !== "string" || !uuid.test(value.operation_id)
        || !Array.isArray(value.capabilities) || typeof value.reason !== "string") throw new TypeError("Invalid permission request");
      // The account service validates the bounded capability allowlist again.
      return execute({ operation: "request", operation_id: value.operation_id,
        capabilities: value.capabilities as OrganizationCapability[], reason: value.reason }, context);
    },
  };
}
