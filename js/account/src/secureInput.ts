import type { ToolActivity } from 'nanocodex-react/agent';

export type SecureInputRequest = Readonly<{ type: 'secure_input'; status: 'input_required'; request_id: string; agent_id: string; origin: string; expires_at: number; kind: 'browser_password' }>;
export function decodeSecureInput(tool: ToolActivity): SecureInputRequest | undefined {
  if (tool.name.split('.').at(-1) !== 'request_secure_input' || tool.status !== 'completed' || !tool.output) return;
  try {
    const value: unknown = JSON.parse(tool.output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== 7 || Object.keys(v).some(k => !['type','status','request_id','agent_id','origin','expires_at','kind'].includes(k))
      || v.type !== 'secure_input' || v.status !== 'input_required' || v.kind !== 'browser_password'
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
async function sendSecureInput(intake: SecureInputRequest, input: {value: string} | {action:'cancel'}, request: typeof fetch): Promise<string> {
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
      || !('action' in input ? ['cancelled'] : ['filled','submitted','action_required','outcome_unknown']).includes(String(r.status))) throw new Error();
    return JSON.stringify({ type: 'secure_input_receipt', request_id: intake.request_id, status: r.status });
  } catch { throw new Error('Secure input could not be confirmed. Check the destination before starting another request.'); }
}
