// One killable workerd process for managed-curl-recovery.test.mjs: the normal
// account ingress, Managed API and Egress workers over persisted SQLite/R2.
// Only external provider HTTP leaves through CONTROL to the parent test.
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
const [directory, controlBase] = process.argv.slice(2);
const workers = JSON.parse(await readFile(directory + '/workers.json', 'utf8'));
const control = async request => {
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
  return fetch(controlBase + '/provider', { method: 'POST', body: JSON.stringify({
    url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body,
  }) });
};
const mf = new Miniflare({
  host: '127.0.0.1', port: 0,
  durableObjectsPersist: directory + '/state/sqlite', r2Persist: directory + '/state/r2',
  workers: workers.map(worker => worker.name === 'provider' ? { ...worker, serviceBindings: { CONTROL: control } } : worker),
});
process.send({ ready: String(await mf.ready) });
