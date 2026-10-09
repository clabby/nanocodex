"""Provider-side Code Mode helpers for real CLI journeys (no host behavior stubs)."""
import copy
import json

MARKER = '__CLI_NESTED_RESULT__'


def wrap_tool(block):
    """Have synthetic inference invoke the real nested tool through public exec."""
    if block.get('type') != 'tool_use' or block['name'] in ('exec', 'wait'):
        return block
    name, args = json.dumps(block['name']), json.dumps(block['input'])
    code = '// @exec: {"yield_time_ms":120000}\n'
    code += f'''try {{
const r = await tools[{name}]({args});
text({json.dumps(MARKER)} + JSON.stringify(r));
for (const b of (r.content || [])) if (b.type === 'image') image(b);
}} catch (e) {{
text({json.dumps(MARKER)} + JSON.stringify(e && typeof e === 'object' && e.content ? e : {{content:[{{type:'text',text:String(e)}}],isError:true}}));
throw e;
}}'''
    return dict(block, name='exec', input={'code': code})


def nested_result(receipt):
    """Read the actual nested envelope printed by wrap_tool, if present."""
    blocks = receipt.get('content', [])
    if isinstance(blocks, str):
        blocks = [{'type': 'text', 'text': blocks}]
    for block in blocks:
        text = block.get('text', '')
        if text.startswith(MARKER):
            return json.loads(text[len(MARKER):])
    return None


def unwrap_request(request):
    """Normalize printed envelopes for effect assertions; keep the real catalog."""
    request = copy.deepcopy(request)
    if 'messages' not in request:
        return request
    names = {tool['name'] for tool in request.get('tools', []) if tool.get('name')}
    assert names == {'exec', 'wait'}, f'CLI must expose only Code Mode: {names}'
    for message in request['messages']:
        if not isinstance(message.get('content'), list):
            continue
        for receipt in message['content']:
            if receipt.get('type') != 'tool_result':
                continue
            nested = nested_result(receipt)
            if nested is None:
                continue
            receipt['fixture_code_mode_receipt'] = copy.deepcopy(receipt)
            content = nested.get('content', [{'type':'text','text':json.dumps(nested)}])
            for block in content:
                if block.get('type') == 'image' and 'data' in block:
                    block['source'] = {'type':'base64','data':block.pop('data'),'media_type':block.pop('mimeType')}
            receipt['content'] = content
            receipt['is_error'] = bool(nested.get('isError'))
            receipt['fixture_nested_result'] = nested
    return request


def normalize_request(request, artifact):
    with (artifact / 'provider-wire.jsonl').open('a') as trace:
        trace.write(json.dumps(request) + '\n')
    assert sorted(tool['name'] for tool in request.get('tools', [])) == ['exec', 'wait'], 'CLI catalog must be exactly exec/wait'
    return unwrap_request(request)
