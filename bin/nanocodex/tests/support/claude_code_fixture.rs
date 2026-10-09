//! Provider-side forwarding through the shipped CLI Code Mode boundary.
use serde_json::{Value, json};
const MARKER: &str = "__CLI_NESTED_RESULT__";

pub fn tool(id: String, name: &str, input: Value) -> Value {
    let code = format!(
        r#"// @exec: {{"yield_time_ms":120000}}
try {{
const r = await tools[{}]({input});
text({} + JSON.stringify(r));
for (const b of (r.content || [])) if (b.type === 'image') image(b);
}} catch (e) {{
text({} + JSON.stringify(e && typeof e === 'object' && e.content ? e : {{content:[{{type:'text',text:String(e)}}],isError:true}}));
throw e;
}}"#,
        json!(name),
        json!(MARKER),
        json!(MARKER)
    );
    json!({"type":"tool_use","id":id,"name":"exec","input":{"code":code}})
}

pub fn normalize(mut body: Value) -> Value {
    let names: std::collections::BTreeSet<_> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(
        names,
        ["exec", "wait"].into_iter().collect(),
        "only Code Mode is public"
    );
    for message in body["messages"].as_array_mut().unwrap() {
        let Some(content) = message["content"].as_array_mut() else {
            continue;
        };
        for receipt in content {
            if receipt["type"] != "tool_result" {
                continue;
            }
            let nested = receipt["content"]
                .as_array()
                .and_then(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .find_map(|text| text.strip_prefix(MARKER))
                })
                .map(|text| serde_json::from_str::<Value>(text).expect("printed native envelope"));
            if let Some(nested) = nested {
                receipt["fixture_code_mode_receipt"] = receipt.clone();
                receipt["content"] = nested
                    .get("content")
                    .cloned()
                    .unwrap_or_else(|| json!([{ "type":"text", "text":nested.to_string() }]));
                receipt["is_error"] = json!(nested["isError"].as_bool().unwrap_or(false));
            }
        }
    }
    body
}
