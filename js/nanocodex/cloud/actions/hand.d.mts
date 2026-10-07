import type { Client } from "../Client.mjs";

/** One Hand as the account remembers it, whether or not it is reachable. */
export type HandEntry = Readonly<{
  id: string;
  name: string;
  kind: "hand" | "vm";
  /** `null` when presence could not be determined within the probe deadline. */
  online: boolean | null;
  health: "connected" | "offline" | "unknown";
}>;

export declare namespace list {
  type Result = Readonly<{
    data: readonly HandEntry[];
    coverage: "known_account_and_workspace";
    /** `false` when a source could not be read, so the listing may omit Hands. */
    complete: boolean;
  }>;
  type ReturnType = Promise<Result>;
  type ErrorType = Error;
}

/** Every Hand this account still remembers, including offline registrations. */
export function list(client: Client): list.ReturnType;

export declare namespace forget {
  type Options = Readonly<{
    /** Remove a Hand that is connected right now, dropping its routing. */
    force?: boolean | undefined;
  }>;
  type Result = Readonly<{
    /** `false` when the account already had no such Hand; the call is idempotent. */
    forgotten: boolean;
  }>;
  type ReturnType = Promise<Result>;
  type ErrorType = Error;
}

/** Removes one Hand; rejects a connected Hand unless `force` is set. */
export function forget(client: Client, id: string, options?: forget.Options): forget.ReturnType;

export declare namespace prune {
  type Result = Readonly<{
    /** Identifiers removed by this call, in account order. */
    forgotten: readonly string[];
    complete: boolean;
  }>;
  type ReturnType = Promise<Result>;
  type ErrorType = Error;
}

/** Removes every Hand observed definitively offline. */
export function prune(client: Client): prune.ReturnType;
