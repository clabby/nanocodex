import { useEffect, useRef, useState } from "react";
import { AccountChooser } from "nanocodex-connect-ui/AccountChooser";
import { useAccountSession } from "./AccountSession";
import { decidePermissionRequest, permissionRequestReference, readPermissionRequest, type PermissionRequest, type PermissionRequestReference } from "./permissionRequests";
import "./PermissionRequestPage.css";

/** The URL identifies a request; only a matching authenticated account may decide it. */
export function PermissionRequestPage({ url }: { url: URL }) {
  const session = useAccountSession();
  const reference = permissionRequestReference(url);
  return <main className="permission-request-page">
    <h1>Review requested permissions</h1>
    {!reference ? <p role="alert">Invalid permission request link.</p>
      : session.status === "checking" ? <p role="status">Checking your account…</p>
      : !session.account?.persistent ? <AccountChooser
        description="Sign in to the account that owns this API key to review its requested permissions."
        disabled={session.operation !== null} failure={session.error}
        onChooseAccount={selection => void session.chooseAccount(selection)} />
      : <PermissionConsent key={`${session.account.id}:${reference.keyId}:${reference.requestId}`} reference={reference} />}
    {session.account?.persistent ? <button type="button" disabled={session.operation !== null} onClick={() => void session.signOut()}>Use a different account</button> : null}
    <p><a href="/">Return to Nanocodex</a></p>
  </main>;
}
function PermissionConsent({ reference }: { reference: PermissionRequestReference }) {
  const [request, setRequest] = useState<PermissionRequest>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [expired, setExpired] = useState(false);
  const [reload, setReload] = useState(0);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    void readPermissionRequest(reference, controller.signal).then(value => {
      if (!controller.signal.aborted) { setRequest(value); setUncertain(false); }
    }).catch(cause => {
      if (!controller.signal.aborted) setError(message(cause));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [reference.keyId, reference.requestId, reload]);
  useEffect(() => {
    setExpired(Boolean(request && request.expires_at <= Date.now()));
    if (!request || request.status !== "pending") return;
    const timeout = setTimeout(() => setExpired(true), Math.max(0, request.expires_at - Date.now()));
    return () => clearTimeout(timeout);
  }, [request]);
  async function decide(action: "approve" | "deny") {
    if (sending.current || busy || uncertain || !request || !request.can_decide || request.status !== "pending" || request.expires_at <= Date.now()) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const result = await decidePermissionRequest(reference, action);
      if (alive.current) setRequest(result);
    } catch (cause) {
      if (alive.current) { setUncertain(true); setError(message(cause)); }
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  const status = request?.status === "pending" && expired ? "expired" : request?.status;
  return <section aria-label="API key permission request" aria-busy={busy}>
    {!request && busy ? <p role="status">Loading request…</p> : null}
    {request ? <>
      <h2>{request.key_label || "API key"}</h2>
      <p>API key <code>{request.key_id}</code></p>
      <p>Approving adds these permissions to this existing API key. Every client using this key will gain this access until the key or permissions are revoked.</p>
      <ul>{request.capabilities.map(capability => <li key={capability}>{request.capability_descriptions[capability]} <code>{capability}</code></li>)}</ul>
      <h3>Reason supplied by the requester</h3>
      <p className="permission-request-reason">{request.reason || "No reason provided."}</p>
      {status === "pending" ? <>
        <p>Request expires {new Date(request.expires_at).toLocaleString()}.</p>
        {request.can_decide ? <div className="permission-request-actions">
          <button type="button" disabled={busy || uncertain} onClick={() => void decide("deny")}>Deny</button>
          <button type="button" disabled={busy || uncertain} onClick={() => void decide("approve")}>Approve permissions</button>
        </div> : <p>This account cannot decide this request. Use the account that owns the API key and has permission to manage it.</p>}
      </> : <p role="status">{status === "approved" ? "Permissions approved. Return to your conversation to continue with the same API key."
        : status === "denied" ? "Request denied. No permissions were added."
        : "This request has expired. Ask for a new permission request."}</p>}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
    {error || uncertain ? <button type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>Check request status</button> : null}
  </section>;
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The permission request could not be confirmed. Check its status.";
}
