#!/usr/bin/env node
// Measures the JS/CSS a first page load downloads (entry script plus
// modulepreloads and stylesheets in dist/client/index.html) and fails when the
// gzip total exceeds the budget. Run after `pnpm run build`.
//   node scripts/route-loading-measure.mjs [--json] [--budget-kb=N]
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..", "dist", "client");
const args = process.argv.slice(2);
const json = args.includes("--json");
const budgetKb = Number(args.find((a) => a.startsWith("--budget-kb="))?.split("=")[1] ?? 160);

const html = readFileSync(join(root, "index.html"), "utf8");
const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
const rows = assets.map((path) => {
  const bytes = readFileSync(join(root, path));
  return { path, kind: path.endsWith(".css") ? "css" : "js", raw: statSync(join(root, path)).size, gzip: gzipSync(bytes, { level: 9 }).length };
}).sort((a, b) => b.gzip - a.gzip);

const total = (kind) => rows.filter((r) => !kind || r.kind === kind).reduce((s, r) => ({ raw: s.raw + r.raw, gzip: s.gzip + r.gzip }), { raw: 0, gzip: 0 });
const js = total("js");
const summary = { files: rows.length, js, css: total("css"), budgetKb, rows };
const kb = (n) => `${(n / 1024).toFixed(1)}kB`;
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  for (const r of rows) console.log(`${r.path.padEnd(48)} ${kb(r.raw).padStart(9)} gz ${kb(r.gzip).padStart(8)}`);
  console.log(`TOTAL initial JS files=${rows.filter((r) => r.kind === "js").length} raw=${kb(js.raw)} gzip=${kb(js.gzip)} (budget ${budgetKb}kB)`);
}
if (js.gzip > budgetKb * 1024) {
  console.error(`initial JS ${kb(js.gzip)} gzip exceeds ${budgetKb}kB budget`);
  process.exit(1);
}
