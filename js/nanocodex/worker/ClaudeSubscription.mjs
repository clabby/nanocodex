import init, { ClaudeSubscription as WasmClaudeSubscription } from '../pkg-web/nanocodex.js';
import { openSubscription } from '../runtime/claude-subscription.mjs';
let initialization;
/** Opens the actual Rust lifecycle over host-private encrypted CAS storage. */
export async function open(options) {
  if (options?.module === undefined) throw new TypeError('Worker ClaudeSubscription requires a precompiled WASM module');
  await (initialization ??= init({ module_or_path: options.module }).catch(() => { initialization = undefined; throw new Error('Claude WASM initialization failed'); }));
  return openSubscription(options, (encoded) => WasmClaudeSubscription.open(encoded), { replaceHost: true });
}
