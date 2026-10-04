/** Branch documents and assets backed by the existing production account service. */
type PreviewEnv = {
  NANOCODEX_PREVIEW_PRODUCTION?: { fetch(request: Request): Promise<Response> };
};

const BACKEND_PREFIXES = [
  "/api", "/v1", "/git", "/auth", "/webauthn", "/connectors",
  "/sandbox-preview", "/connect-dialog", "/.well-known",
];

/** Preserve the browser origin so production owns authentication and CSRF checks. */
export async function productionPreviewFetch<Env extends PreviewEnv, Context>(
  request: Request,
  env: Env,
  context: Context,
  appFetch: (request: Request, env: Env, context: Context) => Response | Promise<Response>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const backend = !["GET", "HEAD"].includes(request.method)
    || request.headers.has("upgrade")
    || BACKEND_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + "/"));
  if (!backend) return appFetch(request, env, context);
  try {
    if (env.NANOCODEX_PREVIEW_PRODUCTION) {
      // Return the original response, including streams, multiple cookies and upgrades.
      return await env.NANOCODEX_PREVIEW_PRODUCTION.fetch(request);
    }
  } catch { /* Never expose provider exceptions or fall back to local state. */ }
  return Response.json({ error: "preview_backend_unavailable" }, {
    status: 503,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
