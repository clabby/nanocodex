// Real account React components over a synthetic HTTP boundary; no live account or WhatsApp login.
// Run after workspace dependency builds: node js/account/scripts/whatsapp-ui-journey.mjs
// Optional browser executable: CHROME_PATH or NANOCODEX_TEST_BROWSER.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const output = new URL('../../../output/whatsapp-ui/', import.meta.url);
mkdirSync(output, { recursive: true });
const accountId = '018f0000-0000-4000-8000-000000000001';
const storageKey = `nanocodex.whatsapp.attempt:${accountId}`;
const phone = '+14155550123';
const fixtures = {
  account: `
    import { AccountMenu } from './src/AccountMenu';
    import { AccountSessionProvider } from './src/AccountSession';
    import { QueryClientProvider } from '@tanstack/react-query';
    import { appQueryClient } from './src/queryClient';
    import { MemoryRouter } from 'react-router';
    function Journey() { return <MemoryRouter><QueryClientProvider client={appQueryClient}>
      <AccountSessionProvider><AccountMenu inline /></AccountSessionProvider>
    </QueryClientProvider></MemoryRouter>; }
  `,
  isolation: `
    import { WhatsAppConnection } from './src/WhatsAppConnection';
    function Journey() {
      const [account, setAccount] = React.useState('${accountId}');
      return <><button onClick={() => setAccount('018f0000-0000-4000-8000-000000000002')}>
        Switch account</button><WhatsAppConnection accountId={account} /></>;
    }
  `,
};
const bundles = {};
for (const [name, contents] of Object.entries(fixtures)) {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        ${contents}
        createRoot(document.getElementById('root')).render(<Journey />);`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx',
    },
    bundle: true, write: false, outfile: 'app.js', jsx: 'automatic',
  });
  bundles[name] = `<meta name="viewport" content="width=device-width,initial-scale=1">
    <div id="root"></div><style>${result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? ''}</style>
    <script>${result.outputFiles.find(f => f.path.endsWith('.js')).text}</script>`;
}
let attempt = null;
let connected = false;
let starts = 0;
let loseResponse = false;
let neverReached = false;
const trace = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://fixture.test');
  const json = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  // Traces deliberately exclude phone, code, response bodies and operation UUIDs.
  if (url.pathname.startsWith('/v1/')) trace.push({ method: req.method, path: url.pathname });
  if (url.pathname.startsWith('/v1/connectors/whatsapp')) {
    assert.equal(req.headers['x-nanocodex-request'], '1');
    assert.equal(req.headers['sec-fetch-site'], 'same-origin');
    if (req.method === 'GET') assert.equal(req.headers.origin, undefined);
    else assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
  }
  if (url.pathname === '/v1/me') return json({ user: { id: accountId, persistent: true } });
  if (url.pathname === '/v1/api-keys') return json({ data: [] });
  if (url.pathname === '/v1/connectors') return json({ connectors: {} });
  if (url.pathname === '/v1/connectors/mcp-connections') return json({ mcp_connections: [] });
  if (url.pathname === '/v1/credentials') return json({
    ready: false, active: null, openai: { connected: false },
    chatgpt: { connected: false, accounts: [] }, claude: { connected: false, state: 'signed_out' },
  });
  if (url.pathname === '/v1/connectors/whatsapp/start') {
    assert.equal(req.method, 'POST');
    starts++;
    const body = JSON.parse(raw);
    assert.match(body.operation_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.phone, phone);
    // A gateway failure before acceptance leaves no server-side attempt.
    if (neverReached) return json({ error: 'synthetic_transport_failure' }, 503);
    attempt = { operation_id: body.operation_id, state: 'ready', expires_at: Date.now() + 60000 };
    if (loseResponse) return json({ error: 'synthetic_uncertain_response' }, 500);
    return json({ attempt }, 202);
  }
  if (url.pathname === '/v1/connectors/whatsapp/pairing') {
    assert.equal(url.searchParams.get('operation_id'), attempt.operation_id);
    return json({ pairing_code: 'ABCD1234', expires_at: attempt.expires_at });
  }
  if (url.pathname === '/v1/connectors/whatsapp/connections/fixture' && req.method === 'DELETE') {
    connected = false;
    attempt = null;
    return json({ connected: false });
  }
  if (url.pathname === '/v1/connectors/whatsapp') return json({
    connected, state: connected ? 'connected' : 'disconnected',
    connection_id: 'fixture', attempt, coverage: { complete: false },
  });
  if (url.pathname.startsWith('/v1/') || url.pathname === '/api/health') {
    return json({ error: 'fixture_unavailable' }, 404);
  }
  res.setHeader('content-type', 'text/html');
  res.end(bundles[url.searchParams.has('isolation') ? 'isolation' : 'account']);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const executablePath = process.env.CHROME_PATH || process.env.NANOCODEX_TEST_BROWSER;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/connect?connect=whatsapp`;
  const savedOperation = () => page.evaluate(key => sessionStorage.getItem(key), storageKey);
  await page.goto(url);
  await page.getByLabel('WhatsApp phone number').fill('invalid');
  await page.getByRole('button', { name: 'Start linking' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(starts, 0);

  neverReached = true;
  await page.getByLabel('WhatsApp phone number').fill(phone);
  await page.getByRole('button', { name: 'Start linking' }).click();
  await page.getByRole('alert').waitFor();
  const originalOperation = await savedOperation();
  assert.ok(originalOperation);
  await page.reload();
  await page.getByRole('button', { name: 'Retry same linking attempt' }).waitFor();
  neverReached = false;
  loseResponse = true;
  await page.getByLabel('WhatsApp phone number').fill(phone);
  await page.getByRole('button', { name: 'Retry same linking attempt' }).click();
  await page.getByRole('alert').waitFor();
  await page.reload();
  await page.getByLabel('Your private linking code', { exact: true }).waitFor();
  assert.equal(starts, 2);
  assert.equal(attempt.operation_id, originalOperation);
  assert.equal(await savedOperation(), originalOperation);
  assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('ABCD')), false);

  connected = true;
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await page.getByText('WhatsApp is connected.', { exact: true }).waitFor();
  assert.equal(await page.locator('output').count(), 0);
  await page.getByRole('button', { name: 'Unlink WhatsApp' }).click();
  await page.getByLabel('WhatsApp phone number').waitFor();
  loseResponse = false;
  await page.getByLabel('WhatsApp phone number').fill(phone);
  await page.getByRole('button', { name: 'Start linking' }).click();
  await page.locator('output').waitFor();
  attempt.expires_at = Date.now() - 1;
  attempt.state = 'expired';
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await page.getByText('This code expired. Start a new link when you’re ready.').waitFor();
  assert.equal(await page.locator('output').count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL('expired-mobile.png', output)) });

  // Exercise the public component with a changed account prop, without relying on a parent key.
  attempt = null;
  await page.goto(`${url}&isolation=1`);
  await page.getByLabel('WhatsApp phone number').fill(phone);
  await page.getByRole('button', { name: 'Start linking' }).click();
  await page.locator('output').waitFor();
  attempt = null;
  await page.getByRole('button', { name: 'Switch account' }).click();
  assert.equal(await page.locator('output').count(), 0);
  await page.getByLabel('WhatsApp phone number').waitFor();
  assert.equal(await page.getByLabel('WhatsApp phone number').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Retry same linking attempt' }).count(), 0);
  assert.deepEqual(errors, []);
  writeFileSync(new URL('trace.json', output), JSON.stringify({
    passed: [
      'private GET sends same-origin Fetch Metadata and request marker without Origin',
      'private POST and DELETE send exact Origin and request marker',
      'deep link opens account linking form', 'invalid phone makes no request',
      'request not accepted recovers after reload with explicit same UUID retry',
      'uncertain accepted request recovers after reload without duplicate POST',
      'session storage excludes pairing code', 'connected clears code',
      'unlink restores form', 'expired clears code',
      'account switch clears private code, phone, status and operation refs',
    ], trace,
  }, null, 2));
  console.log('PASS WhatsApp account linking, recovery and account isolation journeys');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
