// Real-browser journey for grouped agent activity: live, completed, and failed tools,
// subagents, nested Code Mode, previews, and the reader's scroll position.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const packages = new URL('../../../node_modules/.pnpm/', import.meta.url);
const entry = readdirSync(packages).find(name => /^playwright-core@/.test(name));
const { chromium } = await import(new URL(`${entry}/node_modules/playwright-core/index.mjs`, packages));

const bundle = await build({ entryPoints: [new URL('fixtures/agent-activity.tsx', import.meta.url).pathname], bundle: true,
  write: false, outdir: 'out', jsx: 'automatic', loader: { '.tsx': 'tsx' }, define: { 'process.env.NODE_ENV': '"production"' } });
const file = ext => bundle.outputFiles.find(f => f.path.endsWith(ext)).text;
const theme = process.env.THEME === 'light' ? '#fff;color:#0d0d0d' : '#212121;color:#ececec';
const vars = process.env.THEME === 'light' ? '' : '--terminal-background:#212121;--terminal-foreground:#ececec;--terminal-muted:#a3a3a3;--terminal-border:#383838;--terminal-hover:#2b2b2b;--chat-positive:#72ba96;';
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(file('.js')); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:${theme}}*{box-sizing:border-box}body{font:14px/1.5 system-ui}#root{${vars}--terminal-font-sans:system-ui;max-width:900px;margin:auto;height:100vh;display:flex;flex-direction:column}${file('.css')}#root>.agent-terminal-shell{height:100%;flex:1;border:0}.agent-dom-transcript-inner{font-family:system-ui}.fixture-composer{padding:16px;border-top:1px solid #8884;opacity:.7}</style><div id="root"></div><script src="/app.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const output = new URL('../../../output/agent-activity/', import.meta.url); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, output).pathname });
const evidence = [];
try {
  for (const [name, viewport, mobile] of [['desktop', { width: 1280, height: 900 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const groups = page.locator('.agent-work-group');
    await groups.first().waitFor();
    const done = groups.first();
    // Completed work collapses to an informative summary; artifacts stay visible.
    assert.equal(await done.getAttribute('open'), null);
    const summary = await done.locator(':scope > summary').innerText();
    assert.match(summary, /Worked for \d/); assert.match(summary, /edited 3 files/); assert.match(summary, /3 failed/);
    assert.equal(await page.getByRole('link', { name: /Open preview/ }).getAttribute('href'), 'https://preview.example.com/release');
    assert.ok(await page.locator('img[src^="data:image/svg"]').count() >= 1, 'Code Mode image stays visible');
    await done.locator(':scope > summary').click();
    assert.equal(await done.getAttribute('open'), '');
    assert.match(await done.locator('[data-tool-kind="command"].is-failed .agent-tool-error-line').innerText(), /FAIL release\.test\.ts/);
    assert.match(await done.locator('[data-tool-kind="patch"] .agent-tool-target').innerText(), /2 files/);
    assert.equal(await done.locator('[data-tool-kind="code"] .agent-tool-children > .agent-tool-row').count(), 3);
    const edit = done.locator('[data-tool-kind="edit"]');
    await edit.locator(':scope > details > summary').click();
    await edit.locator('.agent-tool-diff').waitFor();
    assert.ok(await edit.locator('.agent-tool-diff-line.is-add').count() >= 2);
    assert.equal(await edit.locator('.agent-tool-diff-line.is-remove').count(), 1);
    const failed = done.locator('[data-tool-kind="command"].is-failed');
    await failed.locator(':scope > details > summary').click();
    assert.match(await failed.locator('.agent-tool-terminal').innerText(), /\$ pnpm test[\s\S]*expected ready to be true[\s\S]*Exit code 1/);
    const agent = page.locator('.agent-subagent');
    assert.match(await agent.locator(':scope > summary').innerText(), /auditor · Agent 3[\s\S]*finished/);
    await agent.locator(':scope > summary').click();
    assert.match(await agent.locator('.agent-subagent-body').innerText(), /readiness check now blocks/);
    // Generic and MCP tools read as labeled values; raw protocol needs an explicit Details click.
    const mcp = done.locator('.agent-tool-row').filter({ has: page.locator(':scope > details > summary', { hasText: 'Linear · create issue' }) });
    assert.match(await mcp.locator(':scope > details > summary').innerText(), /Title: Follow up/);
    await mcp.locator(':scope > details > summary').click();
    const mcpBody = mcp.locator(':scope > details > .agent-tool-body');
    const readable = await mcpBody.evaluate(body => [...body.children].filter(el => !el.matches('.agent-tool-protocol')).map(el => el.innerText).join('\n'));
    assert.match(readable, /Request[\s\S]*Title\s+Follow up[\s\S]*Team[\s\S]*Key\s+ENG[\s\S]*release[\s\S]*follow-up/);
    assert.match(readable, /Result[\s\S]*ID\s+LIN-1[\s\S]*Assignee[\s\S]*Name\s+Ada Lovelace/);
    assert.doesNotMatch(readable, /[{}"]|content|type/, 'No JSON or protocol envelope in readable tool view');
    const protocol = mcpBody.locator('.agent-tool-protocol');
    assert.equal(await protocol.getAttribute('open'), null);
    assert.equal(await protocol.locator('pre').count(), 0, 'Raw payloads are not rendered until Details opens');
    await protocol.locator(':scope > summary', { hasText: 'Details' }).click();
    const raw = await protocol.innerText();
    assert.match(raw, /mcp__linear__create_issue[\s\S]*Raw input[\s\S]*"title": "Follow up"[\s\S]*Raw output[\s\S]*"content"/);
    await shot(page, `mcp-details-${name}`);
    const errorLines = await done.locator('.agent-tool-row.is-failed > .agent-tool-error-line').allInnerTexts();
    assert.ok(errorLines.includes('Validation failed: head branch release-fix does not exist'), JSON.stringify(errorLines));
    assert.ok(errorLines.includes('Region quota exceeded (quota_exceeded)'), JSON.stringify(errorLines));
    const generic = done.locator('[data-tool-kind="generic"].is-failed');
    assert.match(await generic.locator(':scope > details > summary').innerText(), /Deploy service[\s\S]*Region: eu-west/);
    await generic.locator(':scope > details > summary').click();
    assert.match(await generic.locator('.agent-tool-readable.is-error').innerText(), /Error[\s\S]*Region quota exceeded/);
    const nested = done.locator('[data-tool-kind="code"] .agent-tool-children > [data-tool-kind="mcp"]');
    assert.match(await nested.locator(':scope > details > summary').innerText(), /Notion · search[\s\S]*Query: release plan/);
    await nested.locator(':scope > details > summary').click();
    assert.match(await nested.locator('.agent-tool-readable').last().innerText(), /Title\s+Release plan/);
    for (const text of await done.locator('.agent-tool-row > details > summary').allInnerTexts()) {
      assert.doesNotMatch(text, /[{}]|":/, `Row summary without JSON: ${text}`);
    }
    // Deliberate assistant code and JSON keep their formatting.
    const answer = page.locator('.agent-terminal-markdown.is-assistant').filter({ hasText: 'deploy config' }).last();
    assert.match(await answer.locator('pre').filter({ hasText: 'replicas' }).first().textContent(), /\{\s*"region": "eu-west",\s*"replicas": 2\s*\}/);
    await answer.scrollIntoViewIfNeeded(); await shot(page, `assistant-json-${name}`);
    const rows = await done.locator('.agent-tool-row > details > summary').evaluateAll(list => list.map(el => ({ text: el.innerText.replace(/\s+/g, ' '), height: el.getBoundingClientRect().height, overflow: el.scrollWidth - el.clientWidth })));
    for (const row of rows) assert.ok(row.overflow <= 1 && row.height <= (mobile ? 58 : 34), `Compact row: ${JSON.stringify(row)}`);
    const groupHeight = await done.locator(':scope > summary').evaluate(el => el.getBoundingClientRect().height);
    await edit.scrollIntoViewIfNeeded(); await shot(page, `completed-${name}`);
    await agent.scrollIntoViewIfNeeded(); await shot(page, `subagent-${name}`);

    // A live turn streams thinking and a running command into an open group.
    await page.evaluate(() => { const f = window.fixture; f.append(
      { id: 'u2', kind: 'user', text: 'Run the full suite again.' },
      { id: 'r2', kind: 'reasoning', streaming: true, text: 'Re-running the suite\nChecking the flaky release test' },
      { id: 'live', kind: 'tool', tool: { ...f.tool('live', 'exec_command', 'running', { cmd: 'pnpm test --watch=false' }), startedAtMs: Date.now() - 4000, durationNs: undefined } });
      f.set({ running: true, activity: 'Running exec_command' }); });
    const live = groups.last();
    await page.locator('.agent-live-status').waitFor();
    assert.equal(await live.getAttribute('open'), '');
    assert.match(await live.locator(':scope > summary').innerText(), /Working/);
    assert.match(await page.locator('.agent-live-status').innerText(), /Running command…\s*\d+s/);
    assert.match(await live.locator('[data-tool-kind="thinking"]').innerText(), /Thinking[\s\S]*flaky release test/);
    assert.ok(await live.locator('.agent-tool-status-icon.is-running').count() >= 1);
    await shot(page, `live-${name}`);

    // A reader scrolled into history keeps their place while results stream in.
    const transcript = page.locator('.agent-dom-transcript');
    await transcript.evaluate(el => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')); });
    const anchor = page.locator('.agent-dom-transcript-inner > *').nth(3);
    const before = await anchor.evaluate(el => el.getBoundingClientRect().top);
    await page.evaluate(() => { const f = window.fixture;
      f.replace('live', { id: 'live', kind: 'tool', tool: f.tool('live', 'exec_command', 'completed', { cmd: 'pnpm test --watch=false' }, 'Process exited with code 0\nOutput:\n' + Array.from({ length: 30 }, (_, i) => `ok ${i + 1} release case`).join('\n')) });
      f.append({ id: 'a2', kind: 'assistant', streaming: true, text: 'All tests pass now.\n\n' + 'The suite is green across every region. '.repeat(40) }); });
    await page.waitForTimeout(150);
    assert.ok(Math.abs(await anchor.evaluate(el => el.getBoundingClientRect().top) - before) <= 2, 'Reading position preserved');
    const jump = page.getByRole('button', { name: 'Jump to latest response' });
    await jump.click();
    await page.waitForFunction(() => { const el = document.querySelector('.agent-dom-transcript'); return el.scrollHeight - el.scrollTop - el.clientHeight < 48; });
    assert.equal(await page.locator('.agent-live-status').count(), 0, 'Streaming answer replaces the activity line');

    // Completion collapses the live group into a summary.
    await page.evaluate(() => { const f = window.fixture;
      f.replace('r2', { id: 'r2', kind: 'reasoning', streaming: false, text: 'Re-running the suite' });
      f.replace('a2', { id: 'a2', kind: 'assistant', streaming: false, text: 'All tests pass now.' });
      f.set({ running: false, activity: 'Ready' }); });
    await page.waitForFunction(() => document.querySelectorAll('.agent-work-group')[document.querySelectorAll('.agent-work-group').length - 1].open === false);
    assert.match(await groups.last().locator(':scope > summary').innerText(), /Worked[\s\S]*1 command/);
    await shot(page, `finished-${name}`);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= viewport.width, `No horizontal overflow (${width})`);
    assert.deepEqual(errors, []);
    evidence.push({ name, viewport, summary: summary.replace(/\s+/g, ' '), groupHeight, rows, documentWidth: width, errors });
    await context.tracing.stop({ path: new URL(`trace-${name}.zip`, output).pathname }); await context.close();
  }
  writeFileSync(new URL('results.json', output), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); server.close(); }
