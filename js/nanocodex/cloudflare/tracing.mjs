import { tracing as runtimeTracing } from "cloudflare:workers";

/** Attributes must be content-free metadata, never prompts, credentials or bodies. */
export function setSpanAttributes(span, attributes) {
  if (typeof span.setAttributes === "function") {
    span.setAttributes(attributes);
  } else {
    // The pinned local workerd predates the September 2026 span additions.
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
  }
}

/** Annotate the current invocation/context without creating another child span. */
export function annotateActiveSpan(attributes) {
  const span = runtimeTracing.getActiveSpan?.();
  if (span) setSpanAttributes(span, attributes);
}

/** code must be a static operation label, never derived from a caught error. */
export function recordSpanException(span, code) {
  span.setAttribute("error.type", code);
  // Error objects include their raw message and stack. These can contain secrets.
  span.recordException?.({ code });
}

/** Native nesting and lifetime, with content-free exception events. */
export const tracing = {
  enterSpan(name, callback, ...args) {
    return runtimeTracing.enterSpan(name, span => {
      try {
        const result = callback(span, ...args);
        if (result != null && typeof result.then === "function") {
          return Promise.resolve(result).catch(error => {
            recordSpanException(span, name);
            throw error;
          });
        }
        return result;
      } catch (error) {
        recordSpanException(span, name);
        throw error;
      }
    });
  },
};
