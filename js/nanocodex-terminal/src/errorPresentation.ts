/** A readable error notice plus the untouched source, which belongs behind Details. */
export type AgentErrorPresentation = Readonly<{ summary: string; detail?: string | undefined }>;

const STACK_LINE = /^\s*(?:at\s+\S.*|at\s*$|\S+@\S+:\d+:\d+|[\w$.<>]+ \(\S+:\d+:\d+\)|Caused by:.*|\.\.\. \d+ more)$/;
const MAX_SUMMARY = 240;

/**
 * Turns agent, transport, and provider failures into a short sentence.
 * JSON bodies, stack traces, and serialized error objects never become prose.
 */
export function presentAgentError(raw: unknown): AgentErrorPresentation {
  const source = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : safeStringify(raw);
  const text = source.replace(/\r\n?/g, "\n").trim();
  if (!text) return { summary: "Something went wrong." };
  const summary = finish(readable(text));
  return summary === text ? { summary } : { summary, detail: text };
}

function readable(text: string): string {
  // A whole JSON value: prefer its message fields.
  const whole = parseJson(text);
  if (whole !== undefined) return messageFrom(whole) ?? "The agent reported an error.";
  const lines = text.split("\n");
  const firstStack = lines.findIndex((line) => STACK_LINE.test(line));
  const head = (firstStack < 0 ? lines : lines.slice(0, firstStack)).join("\n").trim() || lines[0]!.trim();
  // A prefix followed by an embedded JSON body, as in `Request failed (400): {"error":…}`.
  const brace = head.search(/[{[]/);
  if (brace >= 0) {
    const embedded = parseJson(head.slice(brace)) ?? parseJson(head.slice(brace, head.lastIndexOf(head[brace] === "{" ? "}" : "]") + 1));
    const prefix = head.slice(0, brace).replace(/[\s:=-]+$/, "").trim();
    if (embedded !== undefined) {
      const message = messageFrom(embedded);
      return [prefix, message].filter(Boolean).join(": ") || "The agent reported an error.";
    }
    if (/^[{[]/.test(head)) return "The agent reported an error.";
  }
  const first = head.split("\n").find((line) => line.trim())?.trim() ?? head;
  return first.replace(/^(?:Uncaught\s+)?(?:[A-Z]\w*)?Error:\s*(?=\S)/, "");
}

function messageFrom(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const nested = parseJson(value);
    return nested !== undefined ? messageFrom(nested, depth + 1) : value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = messageFrom(item, depth + 1);
      if (message) return message;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error_description", "detail", "error", "reason", "title", "msg", "text"]) {
    const message = messageFrom(record[key], depth + 1);
    if (message) return message;
  }
  for (const key of ["errors", "content"]) {
    const message = messageFrom(record[key], depth + 1);
    if (message) return message;
  }
  return typeof record.code === "string" ? humanizeCode(record.code) : undefined;
}

function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "The agent reported an error.";
}

function finish(text: string): string {
  let value = text.replace(/\s+/g, " ").trim();
  if (!value) return "Something went wrong.";
  if (value.length > MAX_SUMMARY) value = `${value.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
  return value[0]!.toUpperCase() + value.slice(1);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** True when a status line carries a serialized payload or stack rather than a sentence. */
export function looksLikeRawError(text: string): boolean {
  const trimmed = text.trim();
  return /^[{[]/.test(trimmed) || /[:=]\s*[{[]["{[]/.test(trimmed) || trimmed.split("\n").some((line) => STACK_LINE.test(line));
}

/**
 * Settled assistant text that is wholly a protocol envelope (content parts or an
 * error object) is projected into prose or an error notice. Ordinary answers,
 * including fenced code and JSON the user asked for inside prose, are untouched.
 */
export type AssistantPresentation = Readonly<{ kind: "text"; text: string } | { kind: "error"; text: string }>;

export function presentAssistantText(text: string): AssistantPresentation {
  const value = parseJson(text);
  if (value === undefined || value === null || typeof value !== "object") return { kind: "text", text };
  const parts = contentText(value);
  if (parts !== undefined) return { kind: "text", text: parts };
  if (isErrorEnvelope(value)) return { kind: "error", text };
  return { kind: "text", text };
}

function contentText(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (Array.isArray(value)) {
    if (!value.length || !value.every((item) => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string")) return undefined;
    const texts = value.flatMap((item) => {
      const part = item as Record<string, unknown>;
      return ["text", "output_text", "input_text"].includes(String(part.type)) && typeof part.text === "string" ? [part.text] : [];
    });
    return texts.length ? texts.join("\n\n") : undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "message" || record.role === "assistant") return contentText(record.content, depth + 1);
  return undefined;
}

function isErrorEnvelope(value: object): boolean {
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "error" || ("error" in record && record.error !== null && record.error !== undefined)
    || (typeof record.message === "string" && (typeof record.code === "string" || typeof record.status === "number"));
}
