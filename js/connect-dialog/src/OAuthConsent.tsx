import { useEffect, useRef, useState } from "react";
import "./OAuthConsent.css";
import { AccountChooser } from "nanocodex-connect-ui/AccountChooser";
import {
  BrowserAccountReauthenticationRequiredError,
  logoutBrowserAccountSession,
  readBrowserAccountSession,
  type BrowserAccountSession,
} from "nanocodex-connect-ui/browserAccountSession";
import {
  isLocalDevelopmentOrigin,
  productionConnectApiOrigin,
} from "nanocodex-connect-ui/connectPolicy.mjs";

const routingHeaders = { "x-nanocodex-connect-client": "onboarding" };
const opaqueId = /^[A-Za-z0-9_-]{43}$/;
type ConsentRequest = Readonly<{
  client_id: string;
  client_name: string;
  app_id: string;
  app_origin: string;
  redirect_uri: string;
  resource: string;
  resources: readonly string[];
  scope: string;
  base_resources: readonly string[];
  scope_resources: Readonly<Record<string, readonly string[]>>;
}>;

/** A top-level, server-bound OAuth request; never accepts app claims from a parent. */
export function OAuthConsent() {
  const [request, setRequest] = useState<ConsentRequest>();
  const [selectedScopes, setSelectedScopes] = useState<readonly string[]>([]);
  const [account, setAccount] = useState<BrowserAccountSession | null>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const operation = useRef(false);
  const requestIds = new URLSearchParams(window.location.search).getAll("oauth_request");
  const requestId = requestIds.length === 1 && opaqueId.test(requestIds[0]!) ? requestIds[0]! : undefined;
  const apiOrigin = oauthIssuer(new URL(window.location.href));
  const requestUrl = `${apiOrigin}/oauth/requests/${requestId}`;

  useEffect(() => {
    const abort = new AbortController();
    if (!requestId || !apiOrigin || window.parent !== window) {
      setFailure("This authorization link is invalid. Start a new connection from your MCP client.");
      return;
    }
    void (async () => {
      try {
        const response = await fetch(requestUrl, {
          cache: "no-store", credentials: "omit", headers: routingHeaders, signal: abort.signal,
        });
        const body: unknown = await response.json();
        if (!response.ok || !isConsentRequest(body)) {
          throw new Error("This authorization request is invalid, expired, or already used. Start a new connection from your MCP client.");
        }
        if (abort.signal.aborted) return;
        setRequest(body);
        setSelectedScopes(body.scope.split(" ").includes("agent:run") ? ["agent:run"] : []);
        try {
          const session = await readBrowserAccountSession();
          if (!abort.signal.aborted) setAccount(session?.persistent && session.address ? session : null);
        } catch (error) {
          if (error instanceof BrowserAccountReauthenticationRequiredError) {
            if (!abort.signal.aborted) setAccount(null);
          } else throw error;
        }
      } catch (error) {
        if (!abort.signal.aborted) setFailure(errorMessage(error));
      }
    })();
    return () => abort.abort();
  }, [requestId, requestUrl, apiOrigin]);

  async function settle(approve: boolean) {
    if (!request || operation.current || finished || (approve && (!account?.address || !selectedScopes.length))) return;
    operation.current = true;
    setBusy(true);
    setFailure(undefined);
    const scopes = request.scope.split(" ").filter(scope => selectedScopes.includes(scope));
    const resources = [...new Set([...request.base_resources, ...scopes.flatMap(scope => request.scope_resources[scope]!)])];
    let submitted = false;
    try {
      let code: string | undefined;
      if (approve) {
        const authorization = await fetch("/v1/connect/hosted-authorization/authorize", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account_address: account!.address,
            app_id: request.app_id,
            app_origin: request.app_origin,
            resources,
          }),
        });
        const body: unknown = await authorization.json();
        if (authorization.status === 401 || authorization.status === 403) {
          setAccount(null);
          throw new Error("Your account session changed or expired. Sign in again, then review and approve access.");
        }
        if (!authorization.ok || !isRecord(body) || typeof body.code !== "string" || !opaqueId.test(body.code)) {
          throw new Error("Your account could not authorize this request. Try again.");
        }
        code = body.code;
      }
      // A failed transport may still have consumed the request. Never retry an
      // approval or denial automatically (or expose a second submit button).
      submitted = true;
      const response = await fetch(`${requestUrl}/${approve ? "approve" : "deny"}`, {
        method: "POST", credentials: "omit",
        headers: { ...routingHeaders, "content-type": "application/json" },
        body: JSON.stringify(approve ? {
          account_address: account!.address, code, resources, scope: scopes.join(" "),
        } : {}),
      });
      const result: unknown = await response.json();
      if (!response.ok || !isRecord(result) || typeof result.redirect_uri !== "string") {
        throw new Error(isRecord(result) && typeof result.error_description === "string" && result.error_description.length <= 1_000
          ? result.error_description : "The authorization could not be completed. Start a new connection from your MCP client.");
      }
      const target = callbackUrl(result.redirect_uri, request.redirect_uri);
      setFinished(true);
      window.location.assign(target.href);
    } catch (error) {
      setFailure(errorMessage(error));
      if (submitted) setFinished(true);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function changeAccount() {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      await logoutBrowserAccountSession();
      setAccount(null);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  return <section className="connect-onboarding dialog-shell oauth-consent" data-request="oauth-consent">
    <header className="dialog-header">
      <span className="wordmark">Nanocodex Connect</span>
      <span className="secure-label">MCP authorization</span>
    </header>
    <div className="dialog-content">
      {request ? <>
        <section className="request-title" aria-labelledby="oauth-heading">
          <h1 id="oauth-heading">Connect {request.client_name}</h1>
          <p className="request-copy">This client name is provided by its developer and is not verified by Nanocodex.</p>
        </section>
        <section className="oauth-permissions" aria-label="Requested access">
          <h2>Requested access</h2>
          <p>Choose the permissions to share with this client.</p>
          <ul className="oauth-scope-list">{request.scope.split(" ").map(scope => <li key={scope}>
            <label><input type="checkbox" checked={selectedScopes.includes(scope)} disabled={busy || finished}
              onChange={event => setSelectedScopes(current => event.target.checked
                ? [...current, scope] : current.filter(value => value !== scope))} />
              <span>{scopeLabel(scope)}<code>{scope}</code></span>
            </label>
          </li>)}</ul>
          <p>Only the selected permissions are granted.</p>
          <dl className="oauth-destinations">
            <div><dt>MCP server</dt><dd><code>{request.resource}</code></dd></div>
            <div><dt>Return address</dt><dd><code>{request.redirect_uri}</code></dd></div>
          </dl>
        </section>
        {account === undefined && !failure ? <p role="status">Checking your account session…</p> : null}
        {account && !finished ? <section className="oauth-account" aria-label="Selected account">
          <h2>Selected account</h2><code>{account.address}</code>
          <button type="button" disabled={busy} onClick={() => void changeAccount()}>Use another account</button>
        </section> : null}
        {account === null && !finished ? <AccountChooser
          appName="Nanocodex"
          description="Sign in to review access for this MCP client."
          disabled={busy}
          onChooseAccount={selected => {
            if (selected.address) {
              setAccount({ id: "authenticated", address: selected.address, persistent: true });
              setFailure(undefined);
            } else setFailure("Your account did not provide an address. Sign in again.");
          }}
        /> : null}
      </> : !failure ? <p role="status">Loading authorization request…</p> : null}
      {failure ? <p className="dialog-error" role="alert">{failure}</p> : null}
      {finished && !failure ? <p role="status">Returning to your MCP client…</p> : null}
    </div>
    {request && !finished ? <div className="dialog-actions">
      <button type="button" disabled={busy} onClick={() => void settle(false)}>Deny</button>
      <button type="button" disabled={busy || !account?.address || selectedScopes.length === 0} aria-busy={busy} onClick={() => void settle(true)}>
        {busy ? "Working…" : "Allow access"}
      </button>
    </div> : null}
  </section>;
}

function oauthIssuer(url: URL): string | undefined {
  const values = url.searchParams.getAll("oauth_issuer");
  if (values.length === 0) return isLocalDevelopmentOrigin(url.origin) ? url.origin : productionConnectApiOrigin;
  if (values.length !== 1) return undefined;
  const issuer = values[0]!;
  if (issuer === productionConnectApiOrigin || issuer === "https://nanocodex.gakonst.workers.dev") return issuer;
  return isLocalDevelopmentOrigin(url.origin) && issuer === url.origin ? issuer : undefined;
}

function isConsentRequest(value: unknown): value is ConsentRequest {
  if (!isRecord(value) || typeof value.client_id !== "string" || !value.client_id
    || typeof value.client_name !== "string" || !value.client_name || value.client_name.length > 200
    || typeof value.app_id !== "string" || !/^mcp:[A-Za-z0-9_-]{43}$/.test(value.app_id)
    || typeof value.app_origin !== "string" || typeof value.redirect_uri !== "string"
    || typeof value.resource !== "string" || typeof value.scope !== "string" || !value.scope
    || !Array.isArray(value.resources) || value.resources.length > 32
    || value.resources.some(resource => typeof resource !== "string" || resource.length > 512)
    || !Array.isArray(value.base_resources) || !isRecord(value.scope_resources)) return false;
  const scopes = value.scope.split(" ");
  const mappings = value.scope_resources;
  const allResources = value.resources;
  if (new Set(scopes).size !== scopes.length || scopes.some(scope => !scope || !Array.isArray(mappings[scope]))
    || Object.keys(mappings).some(scope => !scopes.includes(scope))) return false;
  const derived = [...value.base_resources, ...scopes.flatMap(scope => mappings[scope] as unknown[])];
  if (derived.some(resource => typeof resource !== "string" || !allResources.includes(resource))
    || value.resources.some(resource => !derived.includes(resource))) return false;
  try {
    const redirect = new URL(value.redirect_uri);
    const resource = new URL(value.resource);
    return redirect.origin === value.app_origin && !redirect.username && !redirect.password && !redirect.hash
      && (redirect.protocol === "https:" || (redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))
      && (resource.protocol === "https:" || (resource.protocol === "http:" && isLocalDevelopmentOrigin(resource.origin)))
      && value.resources.includes(`urn:nanocodex:app:${encodeURIComponent(value.app_id)}`)
      && value.resources.includes(`urn:nanocodex:origin:${encodeURIComponent(value.app_origin)}`)
      && value.resources.includes("urn:nanocodex:authorization:hosted");
  } catch { return false; }
}

function callbackUrl(value: string, expected: string): URL {
  const target = new URL(value);
  const registered = new URL(expected);
  if (target.origin !== registered.origin || target.pathname !== registered.pathname
    || target.username || target.password || target.hash
    || [...registered.searchParams.keys()].some(key =>
      JSON.stringify(target.searchParams.getAll(key)) !== JSON.stringify(registered.searchParams.getAll(key)))) {
    throw new Error("The authorization returned an unexpected callback address. Start a new connection from your MCP client.");
  }
  return target;
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    "agent:run": "Run agents using your connected ChatGPT account and receive final answers and action details.",
    "agents:read": "Read your agents.", "agents:write": "Create and update agents.",
    "history:read": "Read conversation history.",
    "memory:read": "Read saved memory.", "memory:write": "Save and update memory.",
    "data:read": "Read application data.", "data:write": "Save and update application data.",
    "tools:use": "Use tools authorized by this connection.",
  };
  if (scope.startsWith("connector:")) {
    const capability = scope.slice("connector:".length);
    const connectors: Record<string, string> = {
      cloudflare: "Cloudflare", github: "GitHub", gmail: "Gmail", gdrive: "Google Drive",
      gcalendar: "Google Calendar", gtasks: "Google Tasks", gdocs: "Google Docs", gsheets: "Google Sheets",
      gslides: "Google Slides", gcontacts: "Google Contacts", slack: "Slack", x: "X",
      spotify: "Spotify", soundcloud: "SoundCloud", link: "Stripe Link",
    };
    return `Use your connected ${connectors[capability] ?? capability} account through its authorized API.`;
  }
  return labels[scope] ?? "Permission:";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The authorization is unavailable. Start a new connection from your MCP client.";
}
