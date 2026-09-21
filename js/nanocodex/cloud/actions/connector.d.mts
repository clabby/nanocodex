import type { Client } from "../Client.mjs";
import type { CloudAccount } from "../types.mjs";

export declare namespace request {
  type Options = Readonly<{
    connector: Exclude<CloudAccount, "chatgpt">;
    path: string;
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | undefined;
    /** Required when the grant includes more than one account for this service. */
    connectionId?: string | undefined;
    body?: Record<string, unknown> | undefined;
    signal?: AbortSignal | undefined;
  }>;
  type ReturnType = Promise<Response>;
}

/** Returns the provider response (including HTTP failures). Never retries writes. */
export function request(client: Client, options: request.Options): request.ReturnType;
