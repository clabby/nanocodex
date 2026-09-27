export type SpanAttributes = Record<string, string | number | boolean | undefined>;
export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setAttributes?(attributes: SpanAttributes): unknown;
  recordException?(exception: { code: string }): void;
}
/** Only content-free metadata may be supplied. Uses individual attributes on older workerd. */
export declare function setSpanAttributes(span: TraceSpan, attributes: SpanAttributes): void;
/** Annotates the active native span when supported; does not create a span. */
export declare function annotateActiveSpan(attributes: SpanAttributes): void;
/** code must be a static operation label, never derived from a caught error. */
export declare function recordSpanException(span: TraceSpan, code: string): void;
/** Native nested spans that record sanitized failures and rethrow the original error. */
export declare const tracing: {
  enterSpan<T, A extends unknown[]>(name: string, callback: (span: TraceSpan, ...args: A) => T, ...args: A): T;
};
