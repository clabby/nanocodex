import type { ToolActivity } from 'nanocodex-react/agent';

export type SecureInputRequest = Readonly<{ type: 'secure_input'; status: 'input_required'; request_id: string; agent_id: string; origin: string; expires_at: number; kind: 'browser_password' | 'browser_form' }>;
export function decodeSecureInput(tool: ToolActivity): SecureInputRequest | undefined {
  if (tool.name.split('.').at(-1) !== 'request_secure_input' || tool.status !== 'completed' || !tool.output) return;
  try {
    const value: unknown = JSON.parse(tool.output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== 7 || Object.keys(v).some(k => !['type','status','request_id','agent_id','origin','expires_at','kind'].includes(k))
      || v.type !== 'secure_input' || v.status !== 'input_required' || !['browser_password','browser_form'].includes(String(v.kind))
      || typeof v.request_id !== 'string' || !/^[0-9a-f-]{36}$/.test(v.request_id)
      || typeof v.agent_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.agent_id)
      || typeof v.expires_at !== 'number' || !Number.isFinite(v.expires_at) || v.expires_at <= Date.now()
      || typeof v.origin !== 'string') return;
    const url = new URL(v.origin);
    if (url.protocol !== 'https:' || url.origin !== v.origin || url.username || url.password) return;
    return v as SecureInputRequest;
  } catch { return; }
}

/** Private submission is deliberately separate from the conversation transport. */
export async function submitSecureInput(intake: SecureInputRequest, value: string, request: typeof fetch = fetch): Promise<string> {
  return sendSecureInput(intake, {value}, request);
}

export async function cancelSecureInput(intake: SecureInputRequest, request: typeof fetch = fetch): Promise<string> {
  return sendSecureInput(intake, {action:'cancel'}, request);
}
async function sendSecureInput(intake: SecureInputRequest, input: {value: string} | {values: Record<string,string>} | {action:'cancel'}, request: typeof fetch): Promise<string> {
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(intake.agent_id) || !/^[0-9a-f-]{36}$/.test(intake.request_id)) throw new Error();
    if ('value' in input && (intake.expires_at <= Date.now() || !input.value || input.value.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.value))) throw new Error();
    const response = await request(`/v1/agents/${intake.agent_id}/secure-input`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ request_id: intake.request_id, ...input }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const v: unknown = await response.json();
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    const r = v as Record<string, unknown>;
    if (Object.keys(r).length !== 3 || r.type !== 'secure_input_receipt' || r.request_id !== intake.request_id
      || !('action' in input ? ['cancelled'] : (intake.kind === 'browser_form' ? ['filled','outcome_unknown'] : ['filled','submitted','action_required','outcome_unknown'])).includes(String(r.status))) throw new Error();
    return JSON.stringify({ type: 'secure_input_receipt', request_id: intake.request_id, status: r.status });
  } catch { throw new Error('Secure input could not be confirmed. Check the destination before starting another request.'); }
}

export type SecureField = Readonly<{id:string;kind:'password'|'card_number'|'card_expiry'|'card_cvc'|'sensitive_text';selector:string}>;
export type SecureDescription = Readonly<{request_id:string;origin:string;expires_at:number;fields:readonly SecureField[]}>;
const unavailable = () => new Error('Secure input could not be confirmed. Check the destination before starting another request.');
export async function describeSecureInput(intake:SecureInputRequest, request:typeof fetch=fetch):Promise<SecureDescription> {
  try {
    if (intake.kind !== 'browser_form' || intake.expires_at <= Date.now()) throw unavailable();
    const response = await request(`/v1/agents/${intake.agent_id}/secure-input`, {method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({request_id:intake.request_id,action:'describe'})});
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const v = await response.json() as SecureDescription;
    if (!v || Object.keys(v).length !== 4 || Object.keys(v).some(k=>!['request_id','origin','expires_at','fields'].includes(k)) || v.request_id !== intake.request_id || v.origin !== intake.origin || v.expires_at !== intake.expires_at || v.expires_at <= Date.now() || !Array.isArray(v.fields) || !v.fields.length || v.fields.length > 8) throw unavailable();
    const ids = new Set<string>();
    const selectors = new Set<string>();
    for (const f of v.fields) {
      if (!f || Object.keys(f).some(k=>!['id','kind','selector'].includes(k)) || typeof f.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(f.id) || ids.has(f.id) || !['password','card_number','card_expiry','card_cvc','sensitive_text'].includes(f.kind) || typeof f.selector !== 'string' || !f.selector.trim() || f.selector.length > 512 || selectors.has(f.selector)) throw unavailable();
      ids.add(f.id); selectors.add(f.selector);
    }
    return v;
  } catch { throw unavailable(); }
}
export async function submitSecureFields(intake:SecureInputRequest, description:SecureDescription, values:Record<string,string>, request:typeof fetch=fetch):Promise<string> {
  if (intake.kind !== 'browser_form' || intake.expires_at <= Date.now() || description.request_id !== intake.request_id || description.origin !== intake.origin || description.expires_at !== intake.expires_at || Object.keys(values).length !== description.fields.length || description.fields.some(f=>!Object.hasOwn(values,f.id) || typeof values[f.id] !== 'string' || !values[f.id] || values[f.id].length > 4096 || /[\u0000-\u001f\u007f]/.test(values[f.id]))) throw unavailable();
  return sendSecureInput(intake,{values},request);
}
