import { createHash } from "node:crypto";
import { managedImageReference, type ManagedImageReference } from "./managed-image-fetch";
import type { DurableEventHistory } from "./durable-events";

// Bound archive I/O, allocation, and the data handed back to the image tool.
export const SESSION_IMAGE_HISTORY_PAGE_SIZE = 64;
export const SESSION_IMAGE_HISTORY_MAX_PAGES = 4;
export const SESSION_IMAGE_HISTORY_MAX_BYTES = 24 * 1024 * 1024;
export const SESSION_IMAGE_HISTORY_SCAN_MAX_BYTES = 24 * 1024 * 1024;
export const SESSION_IMAGE_REMEMBER_EVENT = "managed.image.generated";
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
type ImageCandidate = ManagedImageReference | { invalid: true; error: string };
function malformed(error: string): ImageCandidate { return { invalid: true, error }; }
function exclusiveReference(block: Record<string, unknown>): ImageCandidate {
  const ref = managedImageReference(Object.fromEntries(["image_url", "file_id"].flatMap(key =>
    block[key] === undefined ? [] : [[key, block[key]]])));
  return ref ?? malformed("recent conversation image reference is malformed or unsupported");
}
function imageBlock(value: unknown): ImageCandidate | undefined {
  const block = record(value);
  if (!block || !["image", "input_image"].includes(String(block.type))) return undefined;
  if (block.image_url !== undefined || block.file_id !== undefined) return exclusiveReference(block);
  // MCP image content is part of the conversation, not arbitrary tool text.
  const ref = typeof block.data === "string" && typeof block.mimeType === "string"
    ? managedImageReference(`data:${block.mimeType};base64,${block.data}`) : undefined;
  return ref ?? malformed("recent conversation image block is malformed or unsupported");
}
function blocks(value: unknown): ImageCandidate[] {
  return Array.isArray(value) ? value.flatMap(block => {
    const ref = imageBlock(block); return ref ? [ref] : [];
  }) : [];
}
function referenceKey(ref: ManagedImageReference): string {
  return "file_id" in ref ? `file:${ref.file_id}` : ref.image_url;
}
function mirrorKey(parent: string, ref: ManagedImageReference): string {
  return `${parent}\n${createHash("sha256").update(referenceKey(ref)).digest("hex")}`;
}
function callId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value) ? value : undefined;
}
type ProjectedImages = {
  images: ImageCandidate[];
  generated: boolean;
  callId?: string;
  parentCallId?: string;
  receipt?: boolean;
  exec?: boolean;
  originCallId?: string;
  wait?: boolean;
};

/** Project only image blocks that really appeared in this session's history. */
export function sessionEventImages(input: { type: string }, sessionId: string,
  rootSessionId: string): ProjectedImages {
  const message = input as { type: string; [key: string]: unknown };
  if (message.type === "turn_accepted" && sessionId === rootSessionId)
    return { images: blocks(message.input), generated: false };
  const event = record(message.event);
  if (message.type !== "event" || event?.request_id !== sessionId) return { images: [], generated: false };
  const payload = record(event.payload);
  if (!payload) return { images: [], generated: false };
  const id = callId(payload.call_id);
  const identity = { callId: id, parentCallId: callId(payload.parent_call_id)
    ?? callId(id?.match(/^(.*)\/code-[0-9]+$/)?.[1]) };
  if (event.type === SESSION_IMAGE_REMEMBER_EVENT) {
    const ref = managedImageReference(payload.reference);
    return { images: [ref ?? malformed("remembered conversation image reference is malformed")], generated: true, receipt: true, ...identity };
  }
  if (event.type === "input.accepted" && (sessionId !== rootSessionId || payload.kind === "steer")) return { images: blocks(payload.input), generated: false };
  if (event.type !== "tool.result") return { images: [], generated: false };
  const successful = payload.is_error !== true && payload.success !== false
    && !["error", "failed", "cancelled"].includes(String(payload.status));
  const generated = ["image_gen__imagegen", "image_gen.imagegen"].includes(String(payload.tool));
  // Failed/cancelled Code Mode can still deliver earlier image content. Only
  // structured generation references require a successful provider operation.
  if (generated && successful) {
    const structured = record(payload.structured_result) ?? record(payload.result);
    if (structured) return { images: [exclusiveReference(structured)], generated: true, ...identity };
  }
  return { images: blocks(payload.content ?? payload.result), generated, ...identity,
    exec: ["exec", "functions.exec", "code_mode", "code_mode__exec", "wait", "functions.wait", "code_mode__wait"].includes(String(payload.tool)),
    originCallId: callId(record(payload.cell)?.origin_call_id),
    wait: ["wait", "functions.wait", "code_mode__wait"].includes(String(payload.tool)) };
}

/** Durable archive reader, scoped by the actual runtime session (including children).
 * No process-global cache: a new Durable Object instance sees the same history.
 * Older images beyond this bounded window intentionally remain unavailable. */
export async function recentSessionImages(options: {
  sessionId: string; rootSessionId: string; count: number;
  history(before: string | undefined, limit: number): Promise<DurableEventHistory<{ type: string }>>;
}): Promise<ManagedImageReference[]> {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 5)
    throw new Error("recent image count must be between 1 and 5");
  const events: { cursor: string; message: { type: string } }[] = [];
  let before: string | undefined;
  let scanBytes = 0;
  let byteLimited = false;
  for (let page = 0; page < SESSION_IMAGE_HISTORY_MAX_PAGES; page++) {
    const history = await options.history(before, SESSION_IMAGE_HISTORY_PAGE_SIZE);
    const newest = [...history.data].sort((a, b) => BigInt(a.cursor) > BigInt(b.cursor) ? -1 : BigInt(a.cursor) < BigInt(b.cursor) ? 1 : 0);
    for (const event of newest) {
      scanBytes += JSON.stringify(event.message).length;
      if (scanBytes > SESSION_IMAGE_HISTORY_SCAN_MAX_BYTES) {
        if (!events.length) throw new Error("recent conversation history event exceeds the byte budget");
        byteLimited = true;
        break;
      }
      events.push(event);
    }
    const oldest = history.data.reduce<string | undefined>((min, event) =>
      min === undefined || BigInt(event.cursor) < BigInt(min) ? event.cursor : min, undefined);
    if (byteLimited || !history.has_more || oldest === undefined || oldest === before) break;
    before = oldest;
  }
  events.sort((a, b) => BigInt(a.cursor) > BigInt(b.cursor) ? -1 : BigInt(a.cursor) < BigInt(b.cursor) ? 1 : 0);
  // Associate each actually delivered nested image occurrence with at most one
  // outer mirror. Receipt/result copies share an occurrence; distinct operations,
  // multiple images in one operation, and extra explicit redisplays do not.
  const mirrors = new Map<string, string[]>();
  const indexedOccurrences = new Set<string>();
  const mirroredReferences = new Set<string>();
  for (const { message } of [...events].reverse()) {
    const projected = sessionEventImages(message, options.sessionId, options.rootSessionId);
    if (projected.exec || !projected.callId || !projected.parentCallId) continue;
    for (const [index, ref] of projected.images.entries()) {
      if ("invalid" in ref) continue;
      const occurrence = projected.callId + "\n" + index;
      if (indexedOccurrences.has(occurrence)) continue;
      indexedOccurrences.add(occurrence);
      const key = mirrorKey(projected.parentCallId, ref);
      mirrors.set(key, [...(mirrors.get(key) ?? []), occurrence]);
      mirroredReferences.add(mirrorKey("", ref));
    }
  }
  const images: ManagedImageReference[] = [];
  const seenOperations = new Set<string>();
  let bytes = 0;
  for (const { message } of events) {
    const projected = sessionEventImages(message, options.sessionId, options.rootSessionId);
    const mapped = projected.images.map((ref, index) => {
      let identity = (projected.generated || (!projected.exec && projected.parentCallId)) && projected.callId
        ? projected.callId + "\n" + index : undefined;
      // A repeated byte-identical result from another call is a distinct image;
      // only the same nested operation's outer exec/wait mirror is coalesced.
      if (projected.wait && !projected.originCallId && !("invalid" in ref)
        && mirroredReferences.has(mirrorKey("", ref))) {
        return { ref: malformed("recent wait image origin is unavailable; please reattach the exact image"), identity: undefined };
      }
      const origin = projected.originCallId ?? projected.callId;
      if (projected.exec && origin && !("invalid" in ref)) identity = mirrors.get(mirrorKey(origin, ref))?.shift();
      return { ref, identity };
    });
    for (const { ref, identity } of mapped.reverse()) {
      if (identity && seenOperations.has(identity)) continue;
      if ("invalid" in ref) throw new Error(ref.error);
      if (identity) seenOperations.add(identity);
      bytes += referenceKey(ref).length;
      if (bytes > SESSION_IMAGE_HISTORY_MAX_BYTES) throw new Error("recent conversation image window exceeds the reference byte budget");
      images.push(ref);
      if (images.length === options.count) return images.reverse();
    }
  }
  return images.reverse();
}
