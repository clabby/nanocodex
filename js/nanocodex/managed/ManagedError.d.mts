export declare class ManagedError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  /** Server advice captured before consuming a rejected response body. */
  readonly retry_after?: number;
  readonly retry_after_deadline_ms?: number;
  constructor(
    code: string,
    message: string,
    options?: { status?: number | undefined; cause?: unknown },
  );
}
