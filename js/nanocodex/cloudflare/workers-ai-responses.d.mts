import type { BrowserHttpRequest } from "../browser/host.mjs";

/** Structural Workers AI binding; provider credentials stay with Cloudflare. */
export type WorkersAiBinding = {
  run(model: "@cf/zai-org/glm-5.3", input: Record<string, unknown>): Promise<unknown>;
};
export type WorkersAiResponsesOptions = Readonly<{
  /** Local transport identity, never fetched. Defaults to https://workers-ai.invalid/v1. */
  apiBaseUrl?: string;
}>;
export type WorkersAiResponsesTransport = Readonly<{
  apiBaseUrl: string;
  createResponse(endpoint: string, sessionId: string, request: BrowserHttpRequest): Promise<Response>;
}>;
/**
 * Buffered, stateless Responses SSE over the GLM-5.3 Workers AI binding.
 * Requires full text history; opaque compaction and unsupported modalities fail explicitly.
 * Custom grammars are supplied as instructions, not enforced by the provider.
 * Cancellation stops waiting; the binding does not expose cancellation of inference.
 */
export function createWorkersAiResponses(ai: WorkersAiBinding, options?: WorkersAiResponsesOptions): WorkersAiResponsesTransport;
