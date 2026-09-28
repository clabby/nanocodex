import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolActivity } from 'nanocodex-react/agent';
import { cancelSecureInput, decodeSecureInput, submitSecureInput } from './secureInput.ts';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hint = () => ({ type: 'secure_input', status: 'input_required', request_id: id, agent_id: 'agent_1', origin: 'https://example.com', expires_at: Date.now() + 300000, kind: 'browser_password' });
const tool = (value = hint()) => ({ name: 'request_secure_input', status: 'completed', output: JSON.stringify(value) }) as ToolActivity;
test('only a bound, unexpired safe tool hint can open secure input', () => {
  assert.ok(decodeSecureInput(tool()));
  assert.equal(decodeSecureInput({ ...tool(), name: 'browser_execute' }), undefined);
  for (const patch of [{ value: 'secret' }, { origin: 'https://user:pass@example.com' }, { agent_id: '../other' }, { expires_at: 1 }, { kind: 'arbitrary_stdin' }]) {
    assert.equal(decodeSecureInput(tool({ ...hint(), ...patch })), undefined);
  }
});
test('secret uses private direct request and only strict receipts reach chat', async () => {
  const request = decodeSecureInput(tool())!;
  const receipt = await submitSecureInput(request, 'synthetic-password', async (url, init) => {
    assert.equal(url, '/v1/agents/agent_1/secure-input');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(init?.body)), { request_id: id, value: 'synthetic-password' });
    return Response.json({ type: 'secure_input_receipt', request_id: id, status: 'filled' });
  });
  assert.equal(receipt.includes('synthetic-password'), false);
  for (const response of [
    { type: 'secure_input_receipt', request_id: id, status: 'filled', value: 'synthetic-password' },
    { type: 'secure_input_receipt', request_id: 'other', status: 'filled' },
    { type: 'secure_input_receipt', request_id: id, status: 'synthetic-password' },
  ]) await assert.rejects(submitSecureInput(request, 'synthetic-password', async () => Response.json(response)));
  await assert.rejects(submitSecureInput(request, 'synthetic-password', async () => { throw new Error('synthetic-password'); }), error => error instanceof Error && !error.message.includes('synthetic-password'));
});

test('cancel revokes the exact request without a value', async () => {
  const request = decodeSecureInput(tool())!;
  const receipt = await cancelSecureInput(request, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {request_id:id,action:'cancel'});
    return Response.json({type:'secure_input_receipt',request_id:id,status:'cancelled'});
  });
  assert.equal(JSON.parse(receipt).status,'cancelled');
});

test('typed descriptions reject unsafe or mismatched schemas', async () => {
  const {describeSecureInput} = await import('./secureInput.ts');
  const request = decodeSecureInput(tool({...hint(),kind:'browser_form'}))!;
  const schema = {request_id:id,origin:request.origin,expires_at:request.expires_at,fields:[{id:'card',kind:'card_number',selector:'#card'}]};
  assert.deepEqual(await describeSecureInput(request,async (_url,init) => {
    assert.equal(init?.credentials,'same-origin');
    assert.deepEqual(JSON.parse(String(init?.body)),{request_id:id,action:'describe'});
    return Response.json(schema);
  }),schema);
  for (const patch of [{origin:'https://other.test'},{expires_at:request.expires_at+1},{submit:true},{value:'synthetic-only'},{fields:[{id:'card',kind:'unknown'}]},{fields:[schema.fields[0],schema.fields[0]]},{fields:[schema.fields[0],{...schema.fields[0],id:'other'}]},{fields:[{...schema.fields[0],value:'synthetic-only'}]}]) await assert.rejects(describeSecureInput(request,async()=>Response.json({...schema,...patch})));
});
test('typed values use exact private payload and never request submission', async () => {
  const {submitSecureFields} = await import('./secureInput.ts');
  const request = decodeSecureInput(tool({...hint(),kind:'browser_form'}))!;
  const schema = {request_id:id,origin:request.origin,expires_at:request.expires_at,fields:[{id:'private',kind:'sensitive_text' as const,selector:'#private'}]};
  let calls = 0;
  const transport:typeof fetch = async (_url,init) => { calls++; assert.deepEqual(JSON.parse(String(init?.body)),{request_id:id,values:{private:'synthetic-only'}}); return Response.json({type:'secure_input_receipt',request_id:id,status:'filled'}); };
  assert.equal(JSON.parse(await submitSecureFields(request,schema,{private:'synthetic-only'},transport)).status,'filled');
  for (const values of ([{},{private:'synthetic-only',extra:'synthetic-only'},{private:''}] as Record<string,string>[])) await assert.rejects(submitSecureFields(request,schema,values,transport));
  assert.equal(calls,1);
  await assert.rejects(submitSecureFields(request,schema,{private:'synthetic-only'},async()=>Response.json({type:'secure_input_receipt',request_id:id,status:'submitted'})));
});
