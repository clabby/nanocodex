// After a deploy, a tab still running the previous build can request route
// chunks that no longer exist. Vite reports that as `vite:preloadError`; reload
// once so the tab picks up the new build instead of showing a broken route.
const RELOAD_KEY = "nanocodex:stale-chunk-reload";
const RELOAD_WINDOW_MS = 60_000;

type RecoveryTarget = Pick<Window, "addEventListener" | "location" | "sessionStorage">;

export function installStaleChunkRecovery(target: RecoveryTarget, now: () => number = Date.now): void {
  target.addEventListener("vite:preloadError", (event) => {
    let last = 0;
    try { last = Number(target.sessionStorage.getItem(RELOAD_KEY)) || 0; } catch {}
    // A second failure within the window is a real outage, not a stale build:
    // let the route's error boundary report it instead of reload-looping.
    if (now() - last < RELOAD_WINDOW_MS) return;
    try { target.sessionStorage.setItem(RELOAD_KEY, String(now())); } catch {}
    event.preventDefault();
    target.location.reload();
  });
}
