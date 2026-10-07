// Loopback-only fake account service. Readiness comes exclusively from live
// publisher catalogs; this fixture does not synthesize machines or screens.
const http = require('http');
const {WebSocketServer} = require('ws');
const key = 'ncx_live_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const peers = new Map(), events = [];
let sequence = 0;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const reply = value => res.end(JSON.stringify(value));
  if (req.url === '/evidence') return reply({events, live: [...peers.values()]});
  if (req.headers.authorization !== `Bearer ${key}`) {
    events.push({type: 'rejected', path: req.url});
    res.statusCode = 401; return reply({});
  }
  const live = [...peers.values()];
  if (req.url === '/v1/me') return reply({user: {id: 'installer-fixture'}});
  if (req.url === '/v1/account/hands') return reply({data: live.flatMap(p => p.catalog?.machines || [])});
  if (req.url === '/v1/account/hands/screens') return reply({surfaces: live.flatMap(p =>
    (p.catalog?.surfaces || []).map(s => ({...s, machine_id: p.catalog.machine_id})))});
  if (req.url.endsWith('/renew')) return reply({ok: true});
  if (req.url.endsWith('/ice')) return reply({iceServers: []});
  events.push({type: 'unhandled_http', path: req.url});
  res.statusCode = 404; reply({});
});
const ws = new WebSocketServer({server, verifyClient: ({req}) => req.headers.authorization === `Bearer ${key}`});
ws.on('connection', (socket, req) => {
  const id = `fixture-${++sequence}`;
  const peer = {id, path: req.url};
  peers.set(id, peer); events.push({type: 'connected', id, path: req.url});
  // Screen publishers wait for broker admission before sending their catalog.
  if (req.url === '/v1/account/hands/host') socket.send(JSON.stringify({type: 'ready', connection_id: id}));
  socket.on('close', () => { peers.delete(id); events.push({type: 'closed', id}); });
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'catalog') {
      peer.catalog = message; events.push({type: 'catalog', id, catalog: message});
      socket.send(JSON.stringify(message.surfaces
        ? {type: 'published', generation: id}
        : {type: 'ready'}));
    } else if (message.type === 'ping') socket.send(JSON.stringify({type: 'pong', nonce: message.nonce}));
    else if (message.type !== 'diagnostic') events.push({type: message.type, id});
  });
});
server.listen(8765, '127.0.0.1');
