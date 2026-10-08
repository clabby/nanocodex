// Real-browser journey for the /agents chat: sidebar and transcript layout, collapsed
// tool activity while streaming, the composer (auto-grow, Enter/Shift+Enter, IME, stop),
// attachments by drag-and-drop, paste and picker delivered as protocol-valid prompt
// input, and readable error notices. Desktop and mobile, dark and light.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
// The managed service's own prompt validator judges what the browser submits.
const protocol = await build({ entryPoints: [new URL('../../managed/src/protocol.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { validatePromptInput } = await import(`data:text/javascript;base64,${Buffer.from(protocol.outputFiles[0].text).toString('base64')}`);
const packages = new URL('../../../node_modules/.pnpm/', import.meta.url);
const entry = readdirSync(packages).find(name => /^playwright-core@/.test(name));
const { chromium } = await import(new URL(`${entry}/node_modules/playwright-core/index.mjs`, packages));

// Voice needs the WASM SDK; this journey exercises typed turns, so a disabled stub stands in.
const voiceStub = { name: 'voice-stub', setup(b) {
  b.onResolve({ filter: /^nanocodex-react$/ }, args => /nanocodex-terminal/.test(args.importer) ? { path: 'nanocodex-react', namespace: 'voice-stub' } : undefined);
  b.onLoad({ filter: /.*/, namespace: 'voice-stub' }, () => ({ loader: 'js', contents: `const idle = Object.freeze({ status: "idle", transcripts: Object.freeze([]), noteTypedInput: async () => {} });
    export const useVoice = () => idle; export const createElevenLabsManager = () => ({}); export const Voice = { voices: [], defaultVoice: "alloy" };` }));
  // The brand mark's module also preloads every route; a static mark stands in.
  b.onResolve({ filter: /\/MainNavigation$/ }, () => ({ path: 'main-navigation', namespace: 'mark-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'mark-stub' }, () => ({ loader: 'js', resolveDir: new URL('..', import.meta.url).pathname,
    contents: `import { createElement } from "react"; export const NanocodexMark = () => createElement("svg", { className: "nanocodex-mark", viewBox: "0 0 24 24", "aria-hidden": true });` }));
  // Node-only SSH dependencies reachable from the sidebar's imports are never executed here.
  b.onResolve({ filter: /^(node:.*|fs|crypto|stream|net|tls|os|path|util|buffer|events|zlib|child_process|node-rsa)$/ }, () => ({ path: 'node-builtin', namespace: 'empty' }));
  b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ loader: 'js', contents: 'module.exports = {};' }));
  b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => ({ path: require.resolve(args.path) }));
} };
const bundle = await build({ entryPoints: [new URL('fixtures/agents-redesign.tsx', import.meta.url).pathname], bundle: true,
  write: false, outdir: 'out', format: 'esm', jsx: 'automatic', loader: { '.tsx': 'tsx', '.woff2': 'empty', '.svg': 'dataurl' }, plugins: [voiceStub],
  define: { 'process.env.NODE_ENV': '"production"' } });
const file = ext => bundle.outputFiles.find(f => f.path.endsWith(ext)).text;
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(file('.js')); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>html,body{margin:0;height:100%}*{box-sizing:border-box}button{border:0}${file('.css')}</style><div id="root"></div><script type="module" src="/app.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const output = new URL('../../../output/agents-redesign/', import.meta.url); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const evidence = [];
const log = (name, detail) => { evidence.push({ step: name, ...detail }); };

// In-page helpers: synthesize real File objects and dispatch native drag/paste events.
const helpers = () => {
  window.makePng = async (name, size = 64) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const context = canvas.getContext('2d'); context.fillStyle = '#e66'; context.fillRect(0, 0, size, size);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return new File([blob], name, { type: 'image/png' });
  };
  window.dropFiles = async (selector, files) => {
    const target = document.querySelector(selector); const data = new DataTransfer();
    for (const item of await Promise.all(files)) data.items.add(item);
    for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const overlay = Boolean(document.querySelector('.agent-composer-drop'));
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(drop);
    return { overlay, prevented: drop.defaultPrevented };
  };
  window.pasteFiles = async (files) => {
    const data = new DataTransfer(); for (const item of await Promise.all(files)) data.items.add(item);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    document.querySelector('.agent-composer textarea').dispatchEvent(event);
    return event.defaultPrevented;
  };
};

const css = (locator, property) => locator.evaluate((el, p) => getComputedStyle(el)[p], property);
const isReddish = color => { const [r, g, b] = color.match(/[\d.]+/g).map(Number); return r > 150 && r > g * 1.6 && r > b * 1.6; };
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

const scenarios = [['desktop-dark', { width: 1280, height: 860 }, false, 'dark'], ['desktop-light', { width: 1280, height: 860 }, false, 'light'],
  ['mobile-dark', { width: 390, height: 844 }, true, 'dark'], ['mobile-light', { width: 390, height: 844 }, true, 'light']];
try {
  for (const [name, viewport, mobile, theme] of scenarios) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    await page.addInitScript(helpers);
    await page.addInitScript(value => { const set = () => { document.documentElement.dataset.theme = value; }; if (document.documentElement) set(); else document.addEventListener("readystatechange", set, { once: true }); }, theme);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const shot = label => page.screenshot({ path: new URL(`${name}-${label}.png`, output).pathname });
    const textarea = page.locator('.agent-composer textarea');
    await textarea.waitFor();
    const fixture = (method, ...args) => page.evaluate(([m, a]) => window.fixture[m](...a), [method, args]);
    const prompts = () => page.evaluate(() => window.fixture.prompts);

    // Layout: persistent sidebar on desktop, drawer on mobile; centered column; composer pinned at the bottom.
    const sidebar = await page.locator('.agent-navigation').boundingBox();
    if (mobile) assert.equal(sidebar, null, 'Mobile sidebar is a closed drawer');
    else assert.ok(sidebar.width >= 240 && sidebar.width <= 264, `Sidebar width ${sidebar.width}`);
    const main = await page.locator('.conversation-main').boundingBox();
    const form = await page.locator('form.agent-composer').boundingBox();
    assert.ok(form.y + form.height >= viewport.height - (mobile ? 16 : 48), `Composer pinned to the bottom (${form.y + form.height})`);
    assert.ok(Math.abs((form.x - main.x) - (main.x + main.width - form.x - form.width)) <= 2, 'Composer is centered');
    if (mobile) {
      await page.getByRole('button', { name: 'Open sidebar' }).click();
      await page.locator('.agent-navigation.is-open').waitFor();
      assert.match(await page.locator('.agent-navigation-thread[aria-current="location"]').innerText(), /Fix the release check[\s\S]*Running/);
      await shot('drawer');
      await page.getByRole('button', { name: 'Close sidebar' }).click();
    }

    // Composer: grows with content up to a bound; Shift+Enter (desktop) or Enter (phone) adds a line.
    await textarea.click();
    const base = (await textarea.boundingBox()).height;
    await textarea.pressSequentially('first line');
    for (let i = 0; i < 3; i++) { await page.keyboard.press(mobile ? 'Enter' : 'Shift+Enter'); await textarea.pressSequentially(`line ${i + 2}`); }
    const grown = (await textarea.boundingBox()).height;
    assert.ok(grown > base + 30, `Composer grows (${base} → ${grown})`);
    assert.equal(await textarea.inputValue(), 'first line\nline 2\nline 3\nline 4');
    assert.equal((await prompts()).length, 0, 'Newline keys never send');
    await textarea.fill(Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n'));
    const capped = (await textarea.boundingBox()).height;
    assert.ok(capped <= (mobile ? 170 : 290) && await css(textarea, 'overflowY') === 'auto', `Composer height is bounded (${capped})`);
    await textarea.fill('');
    assert.ok((await textarea.boundingBox()).height <= base + 1, 'Composer shrinks back');

    // IME: Enter that confirms a composition never sends.
    await textarea.fill('かな');
    await textarea.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); });
    assert.equal((await prompts()).length, 0, 'IME Enter does not send');
    await textarea.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'かな' })));
    await page.waitForTimeout(60); // a real Enter cannot follow compositionend this quickly
    await textarea.fill('');
    log(`${name}:composer`, { base, grown, capped });

    // Send: Enter on desktop, the Send button on a phone keyboard.
    const send = async text => {
      await textarea.fill(text);
      if (mobile) await page.getByRole('button', { name: 'Send message' }).click(); else await textarea.press('Enter');
      await frames(page);
    };
    await send('Run the release check');
    assert.deepEqual(await prompts(), ['Run the release check']);
    assert.equal(await textarea.inputValue(), '', 'Draft clears after sending');

    // Streaming: tool activity is one collapsed summary row with a spinner; nothing auto-expands.
    await fixture('play', 10); await frames(page);
    const group = page.locator('.agent-work').last();
    const details = group.locator('details.agent-work-group');
    await details.waitFor();
    assert.equal(await details.getAttribute('open'), null, 'Live work group stays collapsed');
    assert.equal(await page.locator('.agent-work-body').count(), 0, 'Collapsed rows are not rendered');
    assert.ok(await details.locator('summary .agent-tool-status-icon.is-running').count() === 1, 'Running spinner');
    assert.match(await details.locator(':scope > summary').innerText(), /Working[\s\S]*pnpm test --watch=false/);
    assert.equal(await page.getByRole('button', { name: 'Send message' }).count(), 0, 'Empty draft while running: Stop only');
    assert.match(await page.getByRole('button', { name: 'Stop response' }).getAttribute('class'), /is-primary/);
    await textarea.fill('next');
    assert.equal(await page.getByRole('button', { name: 'Send message' }).count(), 1, 'A draft shows Send beside Stop');
    await textarea.fill('');
    await shot('streaming');
    await fixture('play', 5); await frames(page);
    assert.equal(await details.getAttribute('open'), null, 'Still collapsed after more tool events');
    await fixture('drain'); await page.locator('.agent-live-status').waitFor({ state: 'detached' });
    const summary = await details.locator(':scope > summary').innerText();
    assert.match(summary, /Worked[\s\S]*2 commands[\s\S]*1 failed/);
    assert.equal(await details.getAttribute('open'), null, 'Finished work stays collapsed');
    const answer = page.locator('.agent-terminal-markdown.is-assistant').last();
    assert.ok(await answer.locator('table').count() === 1 && await answer.locator('pre').count() >= 1, 'Tables and code render');

    // Expanding: rows are single collapsed lines; a failure carries a red marker; details on demand.
    await details.locator(':scope > summary').click();
    const rows = details.locator('.agent-work-body > .agent-tool-row:not(.is-thinking)');
    assert.equal(await rows.count(), 3);
    assert.equal(await details.locator('.agent-tool-row > details[open]').count(), 0, 'Rows start collapsed');
    assert.equal(await page.locator('.agent-tool-error-line').count(), 0, 'No error text outside the row');
    const failedRow = details.locator('.agent-tool-row.is-failed');
    assert.ok(isReddish(await css(failedRow.locator('.agent-tool-status-icon.is-failed'), 'color')), 'Failed marker is red');
    assert.ok(!isReddish(await css(rows.first().locator('.agent-tool-status-icon'), 'color')), 'Success marker is monochrome');
    const sizes = await details.locator('.agent-tool-row > details > summary').evaluateAll(list => list.map(el => ({ h: el.getBoundingClientRect().height, o: el.scrollWidth - el.clientWidth, t: el.innerText.replace(/\s+/g, ' ') })));
    for (const row of sizes) assert.ok(row.h <= (mobile ? 58 : 32) && row.o <= 1, `Compact row ${JSON.stringify(row)}`);
    await failedRow.locator(':scope > details > summary').click();
    assert.match(await failedRow.locator('.agent-tool-terminal').innerText(), /\$ pnpm test release\.test\.ts[\s\S]*FAIL release\.test\.ts[\s\S]*Exit code 1/);
    await shot('expanded');
    log(`${name}:activity`, { summary: summary.replace(/\s+/g, ' '), rows: sizes });

    // Attachments: drop on the composer, drop on the transcript, paste, and the picker.
    const chips = page.locator('.agent-composer-chip:not(.is-preparing)');
    const dropped = await page.evaluate(() => window.dropFiles('form.agent-composer', [window.makePng('screen.png')]));
    assert.ok(dropped.overlay && dropped.prevented, 'Drop target highlights and consumes the drop');
    await chips.nth(0).waitFor();
    await page.evaluate(() => window.dropFiles('.agent-dom-transcript', [new File(['# Notes\nship it\n'], 'notes.md', { type: 'text/markdown' })]));
    await chips.nth(1).waitFor();
    assert.equal(await page.evaluate(() => window.pasteFiles([window.makePng('clip.png', 32)])), true, 'Image paste is consumed');
    await chips.nth(2).waitFor();
    await page.locator('.agent-composer input[type="file"]').setInputFiles({ name: 'config.json', mimeType: 'application/json', buffer: Buffer.from('{"region":"eu-west"}') });
    await chips.nth(3).waitFor();
    assert.ok(await chips.nth(0).locator('img[src^="data:image/png;base64,"]').count() === 1, 'Image chip shows a thumbnail');
    await shot('attachments');
    await page.getByRole('button', { name: 'Remove clip.png' }).click();
    assert.equal(await chips.count(), 3, 'A chip can be removed');
    await page.evaluate(() => window.dropFiles('form.agent-composer', [new File([new Uint8Array([0, 1, 2])], 'tool.exe', { type: 'application/octet-stream' })]));
    assert.match(await page.locator('.agent-composer-notice').innerText(), /tool\.exe: attach images, text or code files/);
    await send('attach these');
    const sent = (await prompts()).at(-1);
    assert.ok(Array.isArray(sent), 'Attachments send structured input');
    assert.deepEqual(sent.map(item => item.type), ['text', 'image', 'text', 'text']);
    assert.equal(sent[0].text, 'attach these');
    assert.match(sent[1].image_url, /^data:image\/png;base64,/);
    assert.match(sent[2].text, /^<attached_file name="notes\.md" media_type="text\/markdown">\n# Notes\nship it\n/);
    assert.match(sent[3].text, /name="config\.json"[\s\S]*"region":"eu-west"/);
    validatePromptInput(sent); // The managed service accepts exactly this input.
    assert.equal(await chips.count(), 0, 'Chips clear after sending');
    await fixture('drain'); await frames(page);
    const user = page.locator('.agent-terminal-user').last();
    assert.equal(await user.locator('img[src^="data:image/png"]').count(), 1, 'Sent message shows the image');
    const userText = await user.innerText();
    assert.match(userText, /attach these[\s\S]*notes\.md[\s\S]*config\.json/);
    assert.doesNotMatch(userText, /base64|attached_file|eu-west/, 'Payloads never appear as message text');

    // Leaks: a raw provider error becomes one sentence; the source waits behind Details.
    await send('fail'); await fixture('drain'); await frames(page);
    const notice = page.locator('.agent-error-notice').last();
    await notice.waitFor();
    assert.equal(await notice.locator('.agent-error-notice-body > p').innerText(), 'Request failed (500): Upstream model is overloaded');
    const visible = await notice.evaluate(el => [...el.querySelectorAll('p')].map(p => p.innerText).join('\n'));
    assert.doesNotMatch(visible, /[{}]|worker\.js|\bat /, 'No JSON or stack trace in the notice');
    const raw = notice.locator('details');
    assert.equal(await raw.getAttribute('open'), null);
    await raw.locator('summary').click();
    assert.match(await raw.locator('pre').innerText(), /"type":"server_error"[\s\S]*worker\.js:120:15/);
    await send('envelope'); await fixture('drain'); await frames(page);
    const envelope = await page.locator('.agent-terminal-markdown.is-assistant').last().innerText();
    assert.match(envelope, /The envelope answer, shown as prose\./);
    assert.doesNotMatch(envelope, /output_text|annotations|[{}]/, 'Protocol envelopes render as prose');

    // Stop: cancels the running turn.
    await send('Run it again'); await fixture('play', 10); await frames(page);
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.waitForFunction(() => window.fixture.cancels.length === 1);
    await page.locator('.agent-live-status').waitFor({ state: 'detached' });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= viewport.width, `No horizontal overflow (${width})`);
    assert.deepEqual(errors, []);
    await shot('final');
    log(`${name}:complete`, { prompts: (await prompts()).length, documentWidth: width, sentTypes: sent.map(item => item.type) });
    await context.tracing.stop({ path: new URL(`trace-${name}.zip`, output).pathname }); await context.close();
  }
  writeFileSync(new URL('results.json', output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log('Agents redesign journey passed');
} finally { await browser.close(); server.close(); }
