export type RetryAfterAdvice = {
  retry_after?: number;
  retry_after_deadline_ms?: number;
};
/** Capture validated numeric seconds/HTTP-date advice once at header receipt. */
export declare function retryAfterAdvice(value: unknown, receivedAt?: number, receivedMonotonic?: number): RetryAfterAdvice;
/** Remaining delay from an existing safe epoch-ms deadline, never a fresh duration. */
export declare function retryAfterRemaining(advice: RetryAfterAdvice, now?: number, currentMonotonic?: number): number | undefined;
/** Preserve the nonserialized process-local anchor when wrapping advice in an error. */
export declare function attachRetryAfterAdvice<T extends object>(target: T, advice: RetryAfterAdvice): T & RetryAfterAdvice;
