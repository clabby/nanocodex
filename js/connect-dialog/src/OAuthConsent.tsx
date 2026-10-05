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
  const [connectors, setConnectors] = useState<Readonly<Record<string, unknown>>>();
  const [connectorFailure, setConnectorFailure] = useState<string>();
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

  useEffect(() => {
    const abort = new AbortController();
    setConnectors(undefined);
    setConnectorFailure(undefined);
    if (!account?.address) return;
    void (async () => {
      try {
        const response = await fetch("/v1/connectors", {
          credentials: "same-origin", cache: "no-store", signal: abort.signal,
        });
        const body: unknown = await response.json();
        if (!response.ok || !isRecord(body) || !isRecord(body.connectors)) {
          throw new Error("Connected accounts could not be checked. Reload this page to try again.");
        }
        if (abort.signal.aborted) return;
        const statuses = body.connectors;
        setConnectors(statuses);
        setSelectedScopes(current => current.filter(scope => scopeAvailable(scope, statuses)));
      } catch (error) {
        if (!abort.signal.aborted) setConnectorFailure(errorMessage(error));
      }
    })();
    return () => abort.abort();
  }, [account?.address]);

  const selectableScopes = selectedScopes.filter(scope => scopeAvailable(scope, connectors));

  const requestedScopes = request?.scope.split(" ") ?? [];
  const serviceScopes = requestedScopes.filter(scope => requiredConnector(scope));
  const connectedScopes = serviceScopes.filter(scope => scopeAvailable(scope, connectors));
  const unavailableScopes = serviceScopes.filter(scope => !scopeAvailable(scope, connectors));
  const capabilityGroups = [...new Set(requestedScopes.filter(scope => !requiredConnector(scope)).map(scope => scope.split(":")[0]!))];
  const allServicesSelected = connectedScopes.length > 0 && connectedScopes.every(scope => selectableScopes.includes(scope));

  function scopeChoice(scope: string, compact = false) {
    const available = scopeAvailable(scope, connectors);
    return <label key={scope} className={compact ? "oauth-scope-chip" : "oauth-service-choice"}>
      <input type="checkbox" checked={available && selectedScopes.includes(scope)}
        disabled={busy || finished || !available} aria-label={scopeLabel(scope)}
        onChange={event => setSelectedScopes(current => event.target.checked
          ? [...new Set([...current, scope])] : current.filter(value => value !== scope))} />
      <span>{compact ? scopeAction(scope) : serviceLabel(scope)}</span>
    </label>;
  }

  async function settle(approve: boolean) {
    if (!request || operation.current || finished || (approve && (!account?.address || !selectableScopes.length))) return;
    operation.current = true;
    setBusy(true);
    setFailure(undefined);
    const scopes = request.scope.split(" ").filter(scope => selectableScopes.includes(scope));
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
          throw new Error(responseDescription(body) ?? "Your account could not authorize this request. Try again.");
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
          <p className="oauth-callback">Returns to <strong>{new URL(request.redirect_uri).host}</strong></p>
          <p className="request-copy">Choose what this client can access.</p>
        </section>
        {account === undefined && !failure ? <p role="status">Checking your account session…</p> : null}
        {account && !finished ? <section className="oauth-account" aria-label="Selected account">
          <div><h2>Account</h2><code>{account.address && account.address.length > 20 ? `${account.address.slice(0, 8)}…${account.address.slice(-6)}` : account.address}</code></div>
          <button type="button" disabled={busy} onClick={() => void changeAccount()}>Switch account</button>
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
        <section className="oauth-permissions" aria-label="Requested access">
          <div className="oauth-section-heading"><h2>Choose access</h2><span>Only your selections are shared</span></div>
          {capabilityGroups.length > 0 ? <section aria-labelledby="oauth-capabilities-heading">
            <h3 id="oauth-capabilities-heading">Nanocodex capabilities</h3>
            <div className="oauth-capabilities">{capabilityGroups.map(group => <div className="oauth-capability-row" key={group}>
              <div><h4>{capabilityLabel(group)}</h4><p className="oauth-hint">{capabilityDescription(group)}</p></div>
              <div className="oauth-scope-options" role="group" aria-label={capabilityLabel(group)}>
                {requestedScopes.filter(scope => !requiredConnector(scope) && scope.split(":")[0] === group).map(scope => scopeChoice(scope, true))}
              </div>
            </div>)}</div>
          </section> : null}
          {serviceScopes.length > 0 ? <section className="oauth-services" aria-labelledby="oauth-services-heading">
            <div className="oauth-section-heading">
              <h3 id="oauth-services-heading">Connected services{connectors ? ` · ${connectedScopes.length}` : ""}</h3>
              {connectedScopes.length > 0 ? <button className="oauth-text-action" type="button" disabled={busy || finished}
                onClick={() => setSelectedScopes(current => allServicesSelected
                  ? current.filter(scope => !connectedScopes.includes(scope))
                  : [...new Set([...current, ...connectedScopes])])}>
                {allServicesSelected ? "Clear services" : "Select all services"}
              </button> : null}
            </div>
            <p className="oauth-hint">Access selected services using your existing account permissions.</p>
            {account && !connectors && !connectorFailure ? <p role="status">Checking connected accounts…</p> : null}
            {!account ? <p className="oauth-hint">Sign in to see your connected services.</p> : null}
            {connectorFailure ? <p className="dialog-error" role="alert">{connectorFailure}</p> : null}
            {connectedScopes.length > 0 ? <div className="oauth-service-grid">{connectedScopes.map(scope => scopeChoice(scope))}</div> : null}
            {connectors && connectedScopes.length === 0 ? <p className="oauth-hint">None of the requested services are connected to this account.</p> : null}
            {connectors && unavailableScopes.length > 0 ? <details className="oauth-disclosure">
              <summary>Not connected <span>({unavailableScopes.length})</span></summary>
              <p className="oauth-hint">These services can’t be granted in this connection.</p>
              <div className="oauth-service-grid">{unavailableScopes.map(scope => scopeChoice(scope))}</div>
            </details> : null}
          </section> : null}
          <details className="oauth-disclosure oauth-technical">
            <summary>Connection details</summary>
            <p className="oauth-hint">Client name supplied by its developer. Not verified by Nanocodex.</p>
            <dl className="oauth-destinations">
              {account?.address ? <div><dt>Account</dt><dd><code>{account.address}</code></dd></div> : null}
              <div><dt>MCP server</dt><dd><code>{request.resource}</code></dd></div>
              <div><dt>Return address</dt><dd><code>{request.redirect_uri}</code></dd></div>
              <div><dt>Requested scopes</dt><dd><code>{request.scope}</code></dd></div>
              <div><dt>Selected scopes</dt><dd><code>{selectableScopes.join(" ") || "None"}</code></dd></div>
            </dl>
          </details>
        </section>
      </> : !failure ? <p role="status">Loading authorization request…</p> : null}
      {failure ? <p className="dialog-error" role="alert">{failure}</p> : null}
      {finished && !failure ? <p role="status">Returning to your MCP client…</p> : null}
    </div>
    {request && !finished ? <div className="dialog-actions">
      <p className="oauth-selection-count" role="status">{selectableScopes.length} {selectableScopes.length === 1 ? "permission" : "permissions"} selected</p>
      <button type="button" disabled={busy} onClick={() => void settle(false)}>Deny</button>
      <button type="button" disabled={busy || !account?.address || selectableScopes.length === 0} aria-busy={busy} onClick={() => void settle(true)}>
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

const serviceNames: Record<string, string> = {
  cloudflare: "Cloudflare", github: "GitHub", gmail: "Gmail", gdrive: "Google Drive",
  gcalendar: "Google Calendar", gtasks: "Google Tasks", gdocs: "Google Docs", gsheets: "Google Sheets",
  gslides: "Google Slides", gcontacts: "Google Contacts", slack: "Slack", x: "X",
  spotify: "Spotify", soundcloud: "SoundCloud", link: "Stripe Link", whatsapp: "WhatsApp",
};
function serviceLabel(scope: string): string {
  const name = scope.slice("connector:".length);
  return serviceNames[name] ?? name;
}
function capabilityLabel(group: string): string {
  return ({ agent: "Run agents", agents: "Agents", history: "Conversation history", memory: "Saved memory",
    data: "Application data", tools: "Tools" } as Record<string, string>)[group] ?? group;
}
function capabilityDescription(group: string): string {
  return ({ agent: "Run tasks with your connected ChatGPT account.",
    agents: "Your agent configurations.", history: "Your previous conversations.", memory: "Context saved across conversations.",
    data: "Records stored by your applications.", tools: "Tools authorized by this connection." } as Record<string, string>)[group] ?? "Review this permission in connection details.";
}
function scopeAction(scope: string): string {
  const action = scope.split(":")[1] ?? scope;
  return ({ read: "Read", write: "Write", run: "Allow", use: "Allow", portability: "Export" } as Record<string, string>)[action] ?? action;
}
function scopeLabel(scope: string): string {
  if (requiredConnector(scope)) return `Use ${serviceLabel(scope)}`;
  if (scope === "agent:run") return "Run agents using your connected ChatGPT account";
  if (scope === "tools:use") return "Use tools authorized by this connection";
  return `${scopeAction(scope)} ${capabilityLabel(scope.split(":")[0]!).toLowerCase()}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The authorization is unavailable. Start a new connection from your MCP client.";
}

function requiredConnector(scope: string): string | undefined {
  return scope.startsWith("connector:") ? scope.slice("connector:".length) : undefined;
}
function scopeAvailable(scope: string, connectors: Readonly<Record<string, unknown>> | undefined): boolean {
  const capability = requiredConnector(scope);
  if (!capability) return true;
  const status = connectors?.[capability];
  return isRecord(status) && status.connected === true;
}
function responseDescription(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const message = body.error_description ?? body.message;
  return typeof message === "string" && message.length > 0 && message.length <= 1_000 ? message : undefined;
}
