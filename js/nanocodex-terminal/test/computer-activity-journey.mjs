// Public transcript browser journey. Run: node js/nanocodex-terminal/test/computer-activity-journey.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../account/package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const bundle = await build({ entryPoints: [new URL('../../account/scripts/fixtures/agent-activity.tsx', import.meta.url).pathname], bundle: true,
  write: false, outdir: 'out', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const file = ext => bundle.outputFiles.find(f => f.path.endsWith(ext)).text;
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(file('.js')); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}*{box-sizing:border-box}body{font:14px/1.5 system-ui}#root{height:100vh;max-width:900px;margin:auto;display:flex;flex-direction:column}${file('.css')}#root>.agent-terminal-shell{height:100%;flex:1}</style><div id="root"></div><script src="/app.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const output = new URL('../../../output/computer-activity/', import.meta.url);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
const evidence = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixture);
    const inputs = await page.evaluate(() => {
      const f = window.fixture;
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dfe8f2'; ctx.fillRect(0, 0, 480, 180);
      ctx.fillStyle = '#24364c'; ctx.font = '26px sans-serif'; ctx.fillText('Synthetic dashboard', 28, 100);
      const image = canvas.toDataURL('image/png');
      const call = (id, title, status = 'completed', extra = {}) => ({ id, kind: 'tool', tool: f.tool(id, 'mcp__cua_repl__js', status,
        { title, code: `await cua.action('${id}')` }, { content: [{ type: 'text', text: `result ${id}` }] }, extra) });
      const entries = [call('one', 'Open dashboard'), { id: 'reason', kind: 'reasoning', text: 'Check the selected window', streaming: false },
        call('two', 'Capture dashboard', 'completed', { images: [image] }),
        call('three', 'Select button', 'completed', { output: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Script error: Button unavailable\n' + 'API manual\n'.repeat(220) + 'RAW-END' }] }) }),
        call('four', 'Inspect window'), call('five', 'Wait for dashboard', 'running')];
      window.computerFixture = { entries, call, image };
      f.set({ entries, running: true }); return entries;
    });
    writeFileSync(new URL(`inputs-${width}.json`, output), JSON.stringify(inputs, null, 2));
    const group = page.locator('.agent-computer-activity').first();
    await group.waitFor();
    assert.match(await group.innerText(), /Using computer[\s\S]*5 actions[\s\S]*1 failed[\s\S]*Wait for dashboard/);
    assert.equal(await group.locator('pre').count(), 0);
    await group.locator(':scope > details > summary').focus(); await page.keyboard.press('Enter');
    await group.locator('.agent-work-body').waitFor();
    const order = await group.locator('.agent-work-body > .agent-tool-row').allTextContents();
    assert.equal(order.length, 6); assert.match(order[1], /Thought/);
    // Reader disclosure persists through completion and replay keeps the same order.
    await page.evaluate(() => { const f = window.fixture, c = window.computerFixture; c.entries = c.entries.map(e => e.id === 'five' ? c.call('five', 'Wait for dashboard') : e); f.set({ entries: c.entries, running: false }); });
    await page.waitForFunction(() => document.querySelector('.agent-computer-activity').textContent.includes('Used computer'));
    assert.equal(await group.locator(':scope > details').getAttribute('open'), '');
    await group.locator(':scope > details > summary').click();
    await group.locator('.agent-computer-previews').waitFor();
    assert.match(await group.innerText(), /Captured screenshot · Capture dashboard[\s\S]*Failed: (?:Select button —\s*)?Button unavailable[\s\S]*3 more actions/);
    assert.doesNotMatch(await group.innerText(), /API manual/);
    if (width === 390) {
      assert.equal(await group.locator('.agent-computer-failure-title').isVisible(), false, 'Mobile gives failure diagnostic the full preview width');
      assert.match(await group.locator('.agent-computer-previews p.is-failed').innerText(), /^Failed: Button unavailable$/);
    }
    assert.equal(await group.locator('img').count(), 1);
    await group.locator('img').evaluate(img => img.decode());
    assert.equal(await group.locator('img').evaluate(img => img.naturalWidth), 480);
    await page.screenshot({ path: new URL(`compact-${width}.png`, output).pathname });
    await group.locator(':scope > details > summary').click();
    const failed = group.locator('.agent-work-body > .agent-tool-row').nth(3);
    await failed.locator(':scope > details > summary').click();
    await failed.locator('.agent-tool-protocol > summary').click();
    await failed.locator('.agent-tool-protocol pre').last().waitFor();
    assert.match(await failed.locator('.agent-tool-protocol').innerText(), /RAW-END/);
    // Replaying history, unrelated tools, and Code Mode siblings retain boundaries and output.
    await page.evaluate(() => { const f = window.fixture, c = window.computerFixture;
      f.set({ entries: [{ id: 'u', kind: 'user', text: 'Replay computer activity' }, ...c.entries,
        { id: 'shell', kind: 'tool', tool: f.tool('shell', 'exec_command', 'completed', { cmd: 'echo unrelated' }, 'unrelated output') },
        c.call('six', 'Separate computer action'),
        { id: 'exec', kind: 'tool', tool: f.tool('exec', 'exec', 'completed', 'await tools.run()', 'Independent emitted output', {
          generatedOutput: [{ kind: 'text', text: 'Independent emitted output' }],
          children: [c.call('nested-one', 'Nested first').tool, c.call('nested-two', 'Nested second').tool,
            f.tool('nested-shell', 'exec_command', 'completed', { cmd: 'echo nested' }, 'nested output'), c.call('nested-three', 'Nested third').tool] }) }] }); });
    await page.waitForFunction(() => document.querySelectorAll('.agent-work > .agent-computer-activity').length === 2);
    assert.match(await page.locator('.agent-generated-text').filter({ hasText: 'Independent emitted output' }).innerText(), /Independent emitted output/);
    const exec = page.locator('[data-tool-kind="code"]');
    await exec.locator(':scope > details > summary').click();
    await exec.locator('.agent-tool-children').waitFor();
    assert.equal(await exec.locator('.agent-tool-children > .agent-computer-activity').count(), 2);
    assert.equal(await exec.locator('.agent-tool-children > [data-tool-kind="command"]').count(), 1);
    assert.match(await exec.locator('.agent-tool-children').innerText(), /2 actions[\s\S]*echo nested[\s\S]*1 action/);
    await page.evaluate(() => { const f = window.fixture, c = window.computerFixture;
      f.append({ id: 'wait-boundary', kind: 'assistant', text: 'Continue the pending cell', streaming: false },
        { id: 'wait', kind: 'tool', tool: f.tool('wait', 'wait', 'completed', { cell_id: 'pending' }, 'Independent wait output', {
          generatedOutput: [{ kind: 'text', text: 'Independent wait output' }],
          children: [c.call('cancelled', 'Interrupted capture', 'cancelled').tool] }) }); });
    const wait = page.locator('.agent-tool-row').filter({ has: page.locator(':scope > details > summary', { hasText: 'Wait' }) }).last();
    await wait.locator(':scope > details > summary').click();
    await wait.locator('.agent-computer-activity').waitFor();
    assert.match(await wait.innerText(), /Used computer[\s\S]*1 action[\s\S]*1 cancelled[\s\S]*Cancelled: Interrupted capture/);
    assert.equal(await page.locator('.agent-generated-text').filter({ hasText: 'Independent wait output' }).count(), 1);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(documentWidth <= width, `No horizontal overflow: ${documentWidth} > ${width}`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: new URL(`nested-${width}.png`, output).pathname });
    // text(JSON.stringify(cuaResult)) follows the real public output projection.
    // Exact CUA echoes collapse; independently labeled output and non-CUA results survive.
    const echoInputs = await page.evaluate(() => {
      const f = window.fixture;
      const payload = { isError: true, content: [{ type: 'text', text: 'Script error: Window unavailable\n' +
        Array.from({ length: 900 }, (_, i) => `AX-DOCUMENTATION ${i}: accessibility tree and API manual reference`).join('\n') + '\nECHO-RAW-END' }] };
      const rows = ['exec', 'wait'].map(name => {
        const emissions = [{ type: 'text', text: JSON.stringify(payload) },
          { type: 'text', text: `Independent labeled ${name}: screenshot review complete` },
          { type: 'text', text: 'Unrelated tool result remains visible' }];
        return { id: `echo-${name}`, kind: 'tool', tool: f.tool(`echo-${name}`, `functions.${name}`, 'completed',
          name === 'exec' ? 'text(JSON.stringify(result)); text("Independent labeled exec: screenshot review complete")' : { cell_id: 'echo-cell' },
          'Script completed\nOutput:\n' + emissions.map(item => item.text).join('\n'), {
            generatedOutput: f.projectToolOutput(emissions),
            children: [f.tool(`echo-cua-${name}`, 'mcp__cua_repl__js', 'failed', { title: 'Inspect selected window' }, payload),
              f.tool(`echo-other-${name}`, 'exec_command', 'completed', { cmd: 'echo independent' }, 'Unrelated tool result remains visible')],
          }) };
      });
      f.set({ entries: rows, running: false }); return rows;
    });
    writeFileSync(new URL(`echo-inputs-${width}.json`, output), JSON.stringify(echoInputs, null, 2));
    await page.locator('.agent-generated-text').filter({ hasText: 'Independent labeled exec:' }).waitFor();
    const collapsedEcho = await page.locator('.agent-dom-transcript').innerText();
    assert.doesNotMatch(collapsedEcho, /AX-DOCUMENTATION|ECHO-RAW-END|API manual reference/);
    assert.match(collapsedEcho, /Window unavailable/);
    assert.match(collapsedEcho, /Independent labeled exec: screenshot review complete/);
    assert.match(collapsedEcho, /Independent labeled wait: screenshot review complete/);
    assert.match(collapsedEcho, /Unrelated tool result remains visible/);
    await page.screenshot({ path: new URL(`echo-collapsed-${width}.png`, output).pathname });
    const echoParents = page.locator('.agent-work > .agent-tool-row');
    assert.equal(await echoParents.count(), 2);
    for (let index = 0; index < 2; index++) {
      const parent = echoParents.nth(index);
      await parent.locator(':scope > details > summary').click();
      await parent.locator(':scope > details > .agent-tool-body > .agent-tool-protocol > summary').click();
      const rawOutput = parent.locator(':scope > details > .agent-tool-body > .agent-tool-protocol pre').last();
      await rawOutput.waitFor();
      assert.match(await rawOutput.textContent(), /AX-DOCUMENTATION 899[\s\S]*ECHO-RAW-END/);
    }
    assert.deepEqual(errors, []);
    evidence.push({ width, documentWidth, errors, assertions: 'live count; keyboard disclosure; reasoning order; completion preserves disclosure; bounded failure/screenshot; untruncated raw error; replay; unrelated tools; nested exec/wait groups; cancellation; independent emitted text; exact projected CUA echoes hidden for exec/wait; full parent raw retained' });
    await context.tracing.stop({ path: new URL(`trace-${width}.zip`, output).pathname }); await context.close();
  }
  writeFileSync(new URL('results.json', output), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); server.close(); }
