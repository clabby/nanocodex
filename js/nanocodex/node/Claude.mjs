import { createRequire } from 'node:module';
import { createClaude } from '../runtime/claude.mjs';

/** Explicit Claude Messages runtime; no authentication or tools are inferred. */
export function create(options) {
  return createClaude(options, async (module) => {
    if (module === undefined) return createRequire(import.meta.url)('../pkg-node/nanocodex.js').Nanoclaude;
    const wasm = await import('../pkg-web/nanocodex.js');
    const { initializeBrowserEngine } = await import('../browser/engine.mjs');
    await initializeBrowserEngine({ module });
    return wasm.Nanoclaude;
  }, 'node');
}
