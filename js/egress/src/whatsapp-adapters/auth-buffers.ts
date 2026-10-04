import { Buffer } from 'node:buffer';

/** The encrypted store decodes bytes as Uint8Array; Baileys/libsignal need Buffer methods. */
export function restoreAuthBuffers<T>(value: T): T {
  if (value instanceof Uint8Array) return Buffer.from(value) as T;
  if (Array.isArray(value)) return value.map(restoreAuthBuffers) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreAuthBuffers(item)])) as T;
  }
  return value;
}
