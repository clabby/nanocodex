// Real TeamsPanel and TeamSessionChooser over a synthetic HTTP API (UI coverage only).
// Backend membership/authorization is covered by the separate real HTTP journey.
// CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node js/account/scripts/company-teams-ui-journey.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const output = new URL('../../../output/company-teams/ui/', import.meta.url);
mkdirSync(output, { recursive: true });
const command = 'CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node js/account/scripts/company-teams-ui-journey.mjs';
const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { AccountSessionProvider } from './src/AccountSession';
    import { TeamsPanel } from './src/TeamsPanel';
    import { TeamSessionChooser } from './src/TeamSessionChooser';
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    function Journey() {
      const [open, setOpen] = React.useState(false);
      const [scope, setScope] = React.useState('personal');
      return <><TeamsPanel /><section aria-label="Session creation fixture">
        <p>This fixture records the real chooser callback; it does not start a backend session.</p>
        <output aria-label="Selected session scope">{scope}</output>
        <button onClick={() => setOpen(true)}>New team session</button>
        <button onClick={() => setScope('personal')}>New personal session</button>
        {open && <TeamSessionChooser onClose={() => setOpen(false)} onCreate={id => {setScope(id); setOpen(false);}} />}
      </section></>;
    }
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
      <AccountSessionProvider><Journey /></AccountSessionProvider></QueryClientProvider>);
  ` }, bundle: true, write: false, outfile: 'app.js', jsx: 'automatic',
});
const html = `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>
<style>${bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? ''}</style>
<script>${bundle.outputFiles.find(f => f.path.endsWith('.js')).text}</script>`;
const teams = [];
const requests = [];
const passed = [];
const errors = [];
let invitationCount = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://fixture.test');
  const actor = req.headers.cookie?.includes('actor=invitee') ? 'invitee' : 'owner';
  const body = raw ? JSON.parse(raw) : {};
  const json = (value, status = 200) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value)); };
  // Tokens are synthetic, but never write them to evidence logs or request URLs.
  requests.push({ method: req.method, url: req.url, actor, body: body.token ? {token: '[redacted]'} : body });
  const visible = team => ({id: team.id, name: team.name, company_id: team.company_id, role: team.members[actor]});
  if (url.pathname === '/v1/me') return json({user: {id: actor === 'owner' ? '018f0000-0000-4000-8000-000000000001' : '018f0000-0000-4000-8000-000000000002', persistent: true}});
  if (url.pathname === '/v1/teams') {
    if (req.method === 'GET') {
      return json({teams: teams.filter(t => t.members[actor]).map(visible)});
    }
    if (req.method === 'POST') {
      const team = {id: `team-${teams.length + 1}`, name: body.name, company_id: body.company_id,
        members: {[actor]: 'owner'}, invitations: []};
      teams.push(team);
      return json(visible(team), 201);
    }
  }
  const match = url.pathname.match(/^\/v1\/teams\/([^/]+)(.*)$/);
  if (match) {
    const team = teams.find(t => t.id === match[1]);
    if (!team) return json({error: 'not_found'}, 404);
    const route = match[2];
    if (route === '/invitations/accept' && req.method === 'POST') {
      const invite = team.invitations.find(i => i.token === body.token);
      if (!invite || invite.revoked || invite.accepted_by) return json({error: 'invalid_invitation'}, 409);
      invite.accepted_by = actor;
      team.members[actor] = invite.role;
      return json(visible(team));
    }
    if (!team.members[actor]) return json({error: 'forbidden'}, 403);
    if (!route && req.method === 'GET') return json({...visible(team), members: Object.entries(team.members).map(([user_id, role]) => ({user_id, role})),
      invitations: team.members[actor] === 'owner' ? team.invitations.map(({token, ...invite}) => invite) : []});
    if (route === '/invitations' && req.method === 'POST') {
      const invite = {id: `invite-${++invitationCount}`, token: `synthetic-invite-token-${invitationCount}`, role: body.role, expires_at: Date.now() + 7 * 86400000};
      team.invitations.push(invite);
      return json(invite, 201);
    }
    if (route.startsWith('/invitations/') && req.method === 'DELETE') {
      const invite = team.invitations.find(i => i.id === route.split('/').at(-1));
      if (!invite) return json({error: 'not_found'}, 404);
      invite.revoked = true;
      return json({revoked: true});
    }
  }
  if (url.pathname.startsWith('/v1/')) return json({error: 'fixture_route_missing'}, 404);
  res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROME_PATH || process.env.NANOCODEX_TEST_BROWSER;
let browser;
const contexts = [];
async function newActor(actor, width) {
  const context = await browser.newContext({viewport: {width, height: 1000}});
  contexts.push({actor, context});
  await context.addCookies([{name: 'actor', value: actor, url: origin}]);
  await context.tracing.start({screenshots: true, snapshots: true, sources: true});
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  return page;
}
async function shot(page, name) { await page.screenshot({path: fileURLToPath(new URL(name, output)), fullPage: true}); }
async function visible(locator) { await locator.waitFor({state: 'visible'}); }
try {
  browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
  const owner = await newActor('owner', 1100);
  await owner.goto(origin);
  await visible(owner.getByText('No teams yet.', {exact: true}));
  await owner.getByLabel('Company name', {exact: true}).fill('Example Labs');
  await owner.getByRole('button', {name: 'Create company', exact: true}).click();
  const detail = owner.getByRole('region', {name: 'Team details', exact: true});
  await visible(detail.getByRole('heading', {name: 'Example Labs', exact: true}));
  assert.deepEqual(requests.find(r => r.method === 'POST' && r.url === '/v1/teams').body, {name: 'Example Labs'});
  await owner.getByRole('combobox', {name: /^Company/}).selectOption('team-1');
  await owner.getByLabel('Team name', {exact: true}).fill('Research');
  await owner.getByRole('button', {name: 'Create team', exact: true}).click();
  await visible(detail.getByRole('heading', {name: 'Research', exact: true}));
  assert.deepEqual(requests.filter(r => r.method === 'POST' && r.url === '/v1/teams')[1].body, {name: 'Research', company_id: 'team-1'});
  await owner.getByRole('button', {name: 'Company: Example Labs · owner', exact: true}).click();
  await visible(detail.getByRole('heading', {name: 'Example Labs', exact: true}));
  await owner.getByRole('button', {name: 'Team: Research · owner', exact: true}).click();
  await visible(detail.getByRole('heading', {name: 'Research', exact: true}));
  passed.push('Create company, select it as parent, create subteam, and select both detail views; outgoing company_id is correct.');

  await detail.getByRole('combobox', {name: /^Invitation role/}).selectOption('writer');
  await detail.getByRole('button', {name: 'Create invitation', exact: true}).click();
  await visible(detail.getByRole('textbox', {name: /^Created invitation/}));
  const link = await detail.getByRole('textbox', {name: /^Created invitation/}).inputValue();
  const parsed = new URL(link);
  assert.equal(parsed.origin, origin);
  assert.equal(parsed.pathname, '/connect/access');
  assert.equal(parsed.search, '');
  assert.equal(new URLSearchParams(parsed.hash.slice(1)).get('team_id'), 'team-2');
  assert.equal(new URLSearchParams(parsed.hash.slice(1)).get('team_invitation'), 'synthetic-invite-token-1');
  await visible(detail.getByText(/writer · Pending/));
  await shot(owner, 'owner-created-invitation.png');
  await detail.getByRole('button', {name: 'Dismiss invitation'}).click();
  assert.equal(await detail.getByLabel('Created invitation').count(), 0);

  const invitee = await newActor('invitee', 390);
  await invitee.goto(link);
  await visible(invitee.getByText('No teams yet.', {exact: true}));
  assert.equal(new URL(invitee.url()).hash, '');
  assert.equal(await invitee.getByRole('textbox', {name: /^Team invitation/}).inputValue(), link);
  assert.equal(requests.some(r => r.url.includes('synthetic-invite-token')), false);
  await invitee.getByRole('button', {name: 'Accept invitation', exact: true}).click();
  const memberDetail = invitee.getByRole('region', {name: 'Team details', exact: true});
  await visible(memberDetail.getByRole('heading', {name: 'Research', exact: true}));
  await visible(memberDetail.getByText(/Your role: writer/));
  assert.equal(await invitee.getByRole('textbox', {name: /^Team invitation/}).inputValue(), '');
  assert.equal(await memberDetail.getByRole('button', {name: 'Create invitation'}).count(), 0);
  assert.equal(await invitee.getByRole('button', {name: /Company: Example Labs/}).count(), 0);
  await shot(invitee, 'invitee-accepted-mobile.png');
  passed.push('Generated link contains the token only in its fragment; navigation scrubs the fragment, prefills acceptance, and sends no token in any request URL; acceptance shows writer membership without owner controls or parent membership.');

  // Leave/re-enter the detail so the owner reads the accepted invitation from HTTP.
  await owner.getByRole('button', {name: 'Company: Example Labs · owner', exact: true}).click();
  await owner.getByRole('button', {name: 'Team: Research · owner', exact: true}).click();
  await visible(detail.getByText(/writer · Accepted/));
  await detail.getByRole('combobox', {name: /^Invitation role/}).selectOption('reader');
  await detail.getByRole('button', {name: 'Create invitation', exact: true}).click();
  await visible(detail.getByRole('textbox', {name: /^Created invitation/}));
  const revokedLink = await detail.getByRole('textbox', {name: /^Created invitation/}).inputValue();
  await visible(detail.getByText(/reader · Pending/));
  await detail.getByRole('button', {name: 'Revoke invitation', exact: true}).click();
  await visible(detail.getByText(/reader · Revoked/));
  assert.equal(await detail.getByRole('button', {name: 'Revoke invitation', exact: true}).count(), 0);
  await detail.getByRole('button', {name: 'Dismiss invitation'}).click();
  await shot(owner, 'owner-invitation-statuses.png');
  await invitee.getByRole('textbox', {name: /^Team invitation/}).fill(revokedLink);
  await invitee.getByRole('button', {name: 'Accept invitation', exact: true}).click();
  await visible(invitee.getByRole('alert'));
  assert.equal(await invitee.getByRole('textbox', {name: /^Team invitation/}).inputValue(), revokedLink);
  await shot(invitee, 'revoked-invitation-error.png');
  const beforeInvalid = requests.filter(r => r.url.endsWith('/invitations/accept')).length;
  await invitee.getByRole('textbox', {name: /^Team invitation/}).fill('https://foreign.invalid/#team_id=team-2&team_invitation=invalid');
  await invitee.getByRole('button', {name: 'Accept invitation', exact: true}).click();
  await visible(invitee.getByRole('alert').filter({hasText: 'Paste the complete invitation link'}));
  assert.equal(requests.filter(r => r.url.endsWith('/invitations/accept')).length, beforeInvalid);
  passed.push('Owner sees accepted/pending/revoked invitation states and revoke disappears after success; revoked acceptance displays server failure without clearing input; foreign-origin link fails locally without an acceptance request.');

  // Include a reader membership from the fixture to exercise chooser eligibility.
  teams.push({id: 'read-only', name: 'Read-only archive', members: {invitee: 'reader'}, invitations: []});
  await invitee.getByRole('button', {name: 'New team session', exact: true}).click();
  let chooser = invitee.getByRole('form', {name: 'New team session', exact: true});
  await visible(chooser.getByRole('combobox', {name: /^Team/}));
  assert.equal(await chooser.getByRole('button', {name: 'Start team session'}).isDisabled(), true);
  assert.equal(await invitee.getByLabel('Selected session scope').textContent(), 'personal');
  assert.deepEqual(await chooser.getByRole('combobox', {name: /^Team/}).locator('option').allTextContents(), ['Choose a team', 'Research']);
  await chooser.getByRole('combobox', {name: /^Team/}).selectOption('team-2');
  await shot(invitee, 'explicit-session-scope.png');
  await chooser.getByRole('button', {name: 'Start team session'}).click();
  await visible(invitee.getByLabel('Selected session scope').filter({hasText: 'team-2'}));
  await invitee.getByRole('button', {name: 'New team session', exact: true}).click();
  assert.equal(await chooser.getByRole('combobox', {name: /^Team/}).inputValue(), '');
  assert.equal(await chooser.getByRole('button', {name: 'Start team session'}).isDisabled(), true);
  await chooser.getByRole('button', {name: 'Cancel', exact: true}).click();
  await invitee.getByRole('button', {name: 'New personal session', exact: true}).click();
  assert.equal(await invitee.getByLabel('Selected session scope').textContent(), 'personal');
  passed.push('Chooser excludes reader memberships, requires an explicit choice, passes selected team ID to onCreate, and reopens without a remembered selection; cancellation and personal creation keep personal scope explicit.');
  assert.deepEqual(errors, []);
  console.log('PASS company/team UI journey: ' + passed.length + ' scenario groups');
} catch (error) {
  errors.push(error.stack ?? String(error));
  for (const {actor, context} of contexts) { await shot(context.pages()[0], `${actor}-failure.png`).catch(() => {}); writeFileSync(new URL(`${actor}-failure.txt`, output), await context.pages()[0].locator('body').innerText()); }
  throw error;
} finally {
  for (const {actor, context} of contexts) await context.tracing.stop({path: fileURLToPath(new URL(`${actor}-trace.zip`, output))});
  writeFileSync(new URL('evidence.json', output), JSON.stringify({command, boundary: 'Real React components and browser HTTP against a synthetic API; backend authorization and actual session creation are not asserted here.', passed, errors, requests}, null, 2));
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
