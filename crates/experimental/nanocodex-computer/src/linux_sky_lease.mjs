// Out-of-group owner lease for a provider or native-service process group.
// The owner's IPC disappears even on SIGKILL. Stay alive through the complete
// TERM/KILL grace period, so descendants cannot outlive an exited group leader.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// Only the provider lease owns the shared socket. Native-service leases never
// remove it while another service/client is still using the desktop host.
const cleanupSocket = process.argv[2] === '--cleanup-socket' ? process.argv[3] : undefined;
const cleanupRoot = cleanupSocket ? process.argv[4] : undefined;
const target = cleanupSocket ? 5 : 2;
function cleanup() {
  if (!cleanupSocket || !path.isAbsolute(cleanupSocket) || path.resolve(cleanupSocket) !== cleanupSocket || path.basename(cleanupSocket) !== 'sky.sock') return;
  const directory = path.dirname(cleanupSocket);
  if (!cleanupRoot || !path.isAbsolute(cleanupRoot) || path.dirname(directory) !== path.resolve(cleanupRoot) || !/^nanocodex-sky-[A-Za-z0-9]{6}$/.test(path.basename(directory))) return;
  try {
    const d = fs.lstatSync(directory);
    if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== process.getuid() || (d.mode & 0o077)) return;
    const s = fs.lstatSync(cleanupSocket);
    if (!s.isSocket() || s.uid !== process.getuid()) return;
    fs.unlinkSync(cleanupSocket);
    // Never recursively delete a directory or follow substituted symlinks.
    fs.rmdirSync(directory);
  } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
}
const child = fork(process.argv[target], process.argv.slice(target + 1), {
  detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], execArgv: [],
});
let stopping;
const kill = signal => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
function stop(code = 0) {
  return stopping ??= (async () => {
    kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    kill('SIGKILL');
    try { cleanup(); } catch { code = 1; }
    // Explicit exit also closes inherited stdio and the owner's IPC. The
    // separate group has now been reaped even if its leader exited earlier.
    process.exit(code);
  })();
}
process.on('message', message => {
  if (stopping) return;
  try { child.send(message, error => { if (error) void stop(1); }); }
  catch { void stop(1); }
});
child.on('message', message => {
  if (process.connected) try { process.send(message, error => { if (error) void stop(1); }); }
  catch { void stop(1); }
});
child.once('error', () => { void stop(1); });
child.once('exit', code => { void stop(code ?? (stopping ? 0 : 1)); });
process.once('disconnect', () => { void stop(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void stop(); });
// The owner may have died before this ESM module finished loading.
if (!process.connected) void stop();
