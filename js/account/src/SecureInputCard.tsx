import { useEffect, useRef, useState } from 'react';
import type { ToolActivity } from 'nanocodex-react/agent';
import { useAccountSession } from './AccountSession';
import { cancelSecureInput, decodeSecureInput, describeSecureInput, submitSecureFields, submitSecureInput, type SecureDescription, type SecureInputRequest } from './secureInput';

export function SecureInputCard({ tool, agentId, onReceipt }: { tool: ToolActivity; agentId: string; onReceipt(receipt: string): void }) {
  const account = useAccountSession();
  const request = decodeSecureInput(tool);
  if (!request || request.agent_id !== agentId) return null;
  return <SecureInputForm key={`${account.account?.id}:${tool.callId}`} request={request} authenticated={account.account?.persistent === true} onReceipt={onReceipt} />;
}
export function SecureInputForm({ request, authenticated, onReceipt }: { request: SecureInputRequest; authenticated: boolean; onReceipt(receipt: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  const fields = useRef<Record<string, HTMLInputElement | null>>({});
  const opening = useRef(0);
  const card = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [description, setDescription] = useState<SecureDescription>();
  const [loading, setLoading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const sending = useRef(false);
  const settled = useRef(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState('');
  const clear = () => { opening.current++; if (input.current) input.current.value = ''; Object.values(fields.current).forEach(el => { if (el) el.value = ''; }); };
  useEffect(() => { if (!open && wasOpen.current) { if (trigger.current && !trigger.current.disabled) trigger.current.focus(); else card.current?.focus(); } wasOpen.current = open; }, [open]);
  const show = async () => {
    if (attempted || loading || !authenticated || request.expires_at <= Date.now()) return;
    if (request.kind === 'browser_password') { setOpen(true); return; }
    const generation = ++opening.current; setLoading(true);
    try { const schema = await describeSecureInput(request); if (alive.current && generation === opening.current && request.expires_at > Date.now()) { setDescription(schema); setOpen(true); } }
    catch { if (alive.current && generation === opening.current) { setAttempted(true); setStatus('Secure form could not be loaded. Start a new request.'); } }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    const hide = () => { if (document.visibilityState !== 'visible') { clear(); setOpen(false); } };
    const timer = setTimeout(() => { if (settled.current) return; clear(); setOpen(false); setAttempted(true); setStatus('Request expired.'); }, Math.max(0, request.expires_at - Date.now()));
    document.addEventListener('visibilitychange', hide);
    return () => { alive.current = false; clear(); clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [request.expires_at]);
  const submit = async () => {
    if (sending.current || attempted || !authenticated || (request.kind === 'browser_password' ? !input.current?.value : !description)) return;
    sending.current = true;
    settled.current = true;
    setAttempted(true);
    setStatus('Submitting…');
    const pending = request.kind === 'browser_form' && description
      ? submitSecureFields(request, description, Object.fromEntries(description.fields.map(f => [f.id, fields.current[f.id]?.value ?? ''])))
      : submitSecureInput(request, input.current!.value);
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
  return <section ref={card} tabIndex={-1} className="vault-intake-card" aria-label="One-time secure input">
    <strong>{request.kind === 'browser_form' ? 'Enter website details securely' : 'Enter password securely'}</strong>
    <p>{request.origin}</p>
    <p>Use autofill or type here. Sent once to this website; not saved to Vault or shared in chat.</p>
    {!authenticated ? <p>Sign in to enter secure input.</p> : <button ref={trigger} type="button" disabled={attempted || open || loading} onClick={() => void show()}>{loading ? 'Loading…' : request.kind === 'browser_form' ? 'Enter secure details' : 'Enter password'}</button>}
    {open ? <dialog ref={dialog} aria-label="Secure website input" onCancel={event => { event.preventDefault(); void cancel(); }} style={{ position: 'fixed', top: 'auto', bottom: 0, margin: '0 auto', width: 'min(100%, 36rem)', maxHeight: '85dvh', overflow: 'auto', border: 0, borderRadius: '16px 16px 0 0', padding: '24px', boxSizing: 'border-box' }}><p>{request.origin}</p><form onSubmit={event => { event.preventDefault(); void submit(); }}>
      {request.kind === 'browser_password' ? <label>Password<input ref={input} type="password" name="password" autoComplete="current-password" autoFocus required maxLength={4096} /></label> : description?.fields.map((field, index) => <label key={field.id}>{({password:'Password',card_number:'Card number',card_expiry:'Expiry',card_cvc:'Security code',sensitive_text:'Private text'}[field.kind])}<input ref={el => { fields.current[field.id] = el; }} type="password" name={field.id} autoComplete={{password:'current-password',card_number:'cc-number',card_expiry:'cc-exp',card_cvc:'cc-csc',sensitive_text:'off'}[field.kind]} inputMode={field.kind === 'card_number' || field.kind === 'card_cvc' ? 'numeric' : 'text'} autoFocus={index === 0} required maxLength={4096} /></label>)}
      {request.kind === 'browser_form' ? <p>This app only fills fields; it does not press Pay. The website may react to input. Review before submitting separately.</p> : null}
      <button type="button" onClick={() => void cancel()}>Cancel request</button>
      <button type="submit" disabled={attempted}>{request.kind === 'browser_form' ? 'Fill once' : 'Submit once'}</button>
    </form></dialog> : null}
    {status ? <p role="status">{status}</p> : null}
  </section>;
}
