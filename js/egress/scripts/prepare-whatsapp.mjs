import { builtinModules } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { verifySignaturePlugin } from './whatsapp/verify-signature-plugin.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = fileURLToPath(import.meta.resolve('whatsapp-rust-bridge'));
const source = await readFile(bridgePath, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
if (sha(source) !== '13586c5d558b7a683f1aa5678dadf8cbe664182fbc63608d294c9a5c7378e206') throw new Error('Pinned bridge 0.5.4 source changed; review required');
const scalar = source.match(/initSync\(\{ module: base64ToUint8Array\("([A-Za-z0-9+/=]+)"\) \}\);/);
const start = source.indexOf('var forceNoSimd =');
const marker = 'var __wasmSimdActive = simdUsed;';
const end = source.indexOf(marker);
if (!scalar || start < 0 || end < start) throw new Error('Pinned bridge initialization changed');
const wasm = Buffer.from(scalar[1], 'base64');
if (sha(wasm) !== 'fff589536bfa14fe1e3c3d18ce4b6d7711d773c0eadb3af49b64f60364c814b2') throw new Error('Pinned scalar WASM changed');
const generated = resolve(root, 'src/whatsapp-generated');
await mkdir(generated, { recursive: true });
await writeFile(resolve(generated, 'bridge.wasm'), wasm);
await writeFile(resolve(generated, 'bridge.js'), `import staticBridgeModule from './bridge.wasm';\n` + source.slice(0, start) + 'initSync({ module: staticBridgeModule });\nvar __wasmSimdActive = false;' + source.slice(end + marker.length));
await build({ entryPoints: [fileURLToPath(import.meta.resolve('@whiskeysockets/baileys'))], bundle: true, format: 'esm', platform: 'node', target: 'es2022', mainFields: ['module', 'main'], outfile: resolve(generated, 'baileys.js'),
  external: [...builtinModules, ...builtinModules.map(x => 'node:' + x)],
  alias: { pino: resolve(root, 'src/whatsapp-adapters/silent-logger.js'), ws: resolve(root, 'src/whatsapp-adapters/workers-ws.js'), 'whatsapp-rust-bridge': resolve(generated, 'bridge.js'), ...Object.fromEntries(['jimp', 'sharp', 'audio-decode', 'link-preview-js'].map(x => [x, resolve(root, 'src/whatsapp-adapters/unsupported-media.js')])) },
  plugins: [verifySignaturePlugin, { name: 'static-wasm', setup(build) { build.onResolve({ filter: /\.wasm$/ }, () => ({ path: './bridge.wasm', external: true })); } }],
  banner: { js: 'import { Buffer } from "node:buffer"; import { createRequire as __workersCreateRequire } from "node:module"; const require = __workersCreateRequire("/worker.js");' },
});
