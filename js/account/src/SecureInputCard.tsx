import { useEffect, useRef, useState } from 'react';
import type { ToolActivity } from 'nanocodex-react/agent';
import { useAccountSession } from './AccountSession';
import { cancelSecureInput, decodeSecureInput, submitSecureInput, type SecureInputRequest } from './secureInput';

export function SecureInputCard({ tool, agentId, onReceipt }: { tool: ToolActivity; agentId: string; onReceipt(receipt: string): void }) {
  const account = useAccountSession();
  const request = decodeSecureInput(tool);
  if (!request || request.agent_id !== agentId) return null;
  return <SecureInputForm key={`${account.account?.id}:${tool.callId}`} request={request} authenticated={account.account?.persistent === true} onReceipt={onReceipt} />;
}
export function SecureInputForm({ request, authenticated, onReceipt }: { request: SecureInputRequest; authenticated: boolean; onReceipt(receipt: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const sending = useRef(false);
  const settled = useRef(false);
  const [open, setOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState('');
  const clear = () => { if (input.current) input.current.value = ''; };
  useEffect(() => {
    alive.current = true;
    const hide = () => { if (document.visibilityState !== 'visible') { clear(); setOpen(false); } };
    const timer = setTimeout(() => { if (settled.current) return; clear(); setOpen(false); setAttempted(true); setStatus('Request expired.'); }, Math.max(0, request.expires_at - Date.now()));
    document.addEventListener('visibilitychange', hide);
    return () => { alive.current = false; clear(); clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [request.expires_at]);
  const submit = async () => {
    if (sending.current || attempted || !authenticated || !input.current?.value) return;
    sending.current = true;
    settled.current = true;
    setAttempted(true);
    setStatus('Submitting…');
    const pending = submitSecureInput(request, input.current.value);
    clear(); setOpen(false);
    try {
      const receipt = await pending;
      if (!alive.current) return;
      setStatus(JSON.parse(receipt).status === 'outcome_unknown' ? 'Submission could not be confirmed. Check the destination before trying again.' : JSON.parse(receipt).status === 'action_required' ? 'Password filled. A separate sign-in action is needed.' : 'Input delivered.');
      onReceipt(receipt);
    } catch { if (alive.current) setStatus('Submission could not be confirmed. Check the destination before trying again.'); }
    finally { sending.current = false; }
  };
  const cancel = async () => {
    if (sending.current || attempted) return;
    sending.current = true; settled.current = true; clear(); setOpen(false); setAttempted(true); setStatus('Cancelling…');
    try {
      const receipt = await cancelSecureInput(request);
      if (alive.current) { setStatus('Request cancelled.'); onReceipt(receipt); }
    } catch { if (alive.current) setStatus('Cancellation could not be confirmed. The request will expire.'); }
    finally { sending.current = false; }
  };
  return <section className="vault-intake-card" aria-label="One-time secure input">
    <strong>Enter password securely</strong>
    <p>{request.origin}</p>
    <p>Use your password manager or type here. Sent once to this website; not saved to Vault or shared in chat.</p>
    {!authenticated ? <p>Sign in to enter secure input.</p> : <button type="button" disabled={attempted || open} onClick={() => setOpen(true)}>Enter password</button>}
    {open ? <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>Password<input ref={input} type="password" name="password" autoComplete="current-password" autoFocus required maxLength={4096} /></label>
      <button type="button" onClick={() => void cancel()}>Cancel request</button>
      <button type="submit" disabled={attempted}>Submit once</button>
    </form> : null}
    {status ? <p role="status">{status}</p> : null}
  </section>;
}
