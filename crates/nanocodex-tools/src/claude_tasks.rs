//! Session-local Claude-style task and todo tracking. This is deliberately not an
//! adapter for Codex plans, agents, schedulers, or any durable account service.

use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

const MAX_TASKS: usize = 256;
const MAX_TODOS: usize = 256;
const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 64 * 1024;
const MAX_TEXT: usize = 8 * 1024;
const MAX_METADATA: usize = 16 * 1024;

#[derive(Clone, Debug)]
struct Task {
    id: String,
    subject: String,
    description: String,
    active_form: Option<String>,
    status: String,
    owner: Option<String>,
    metadata: Map<String, Value>,
    blocks: BTreeSet<String>,
    blocked_by: BTreeSet<String>,
}

#[derive(Default, Debug)]
struct State {
    next_id: u64,
    tasks: BTreeMap<String, Task>,
    todos: Vec<Value>,
}

/// In-memory task board scoped to one host-created session. Clones share the
/// same board; independently constructed boards never share data.
#[derive(Clone, Default, Debug)]
pub struct ClaudeTasks {
    state: Arc<Mutex<State>>,
}

impl ClaudeTasks {
    /// Construct an empty independent session board.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Model-visible input schemas for task and todo tracking only.
    #[must_use]
    pub fn definitions() -> Vec<Value> {
        vec![
            json!({"name":"TaskCreate","description":"Create a session-local task.","input_schema":{"type":"object","properties":{"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"metadata":{"type":"object"}},"required":["subject","description"],"additionalProperties":false}}),
            json!({"name":"TaskGet","description":"Retrieve a session-local task by ID.","input_schema":{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"],"additionalProperties":false}}),
            json!({"name":"TaskList","description":"List session-local tasks.","input_schema":{"type":"object","properties":{},"additionalProperties":false}}),
            json!({"name":"TaskUpdate","description":"Update or delete a session-local task; null metadata values delete keys.","input_schema":{"type":"object","properties":{"taskId":{"type":"string"},"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed","deleted"]},"addBlocks":{"type":"array","items":{"type":"string"}},"addBlockedBy":{"type":"array","items":{"type":"string"}},"owner":{"type":"string"},"metadata":{"type":"object"}},"required":["taskId"],"additionalProperties":false}}),
            json!({"name":"TodoWrite","description":"Replace the session-local todo list.","input_schema":{"type":"object","properties":{"todos":{"type":"array","maxItems":MAX_TODOS,"items":{"type":"object","properties":{"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]},"activeForm":{"type":"string"}},"required":["content","status","activeForm"],"additionalProperties":false}}},"required":["todos"],"additionalProperties":false}}),
        ]
    }

    /// Alias for [`Self::definitions`].
    #[must_use]
    pub fn tool_schemas() -> Vec<Value> {
        Self::definitions()
    }

    /// Execute a named operation and return its JSON output as bounded text.
    /// This method has no filesystem, network, process, or cross-session effects.
    pub async fn execute(&self, name: &str, input: Value) -> Result<String, String> {
        if serde_json::to_vec(&input).map_err(|e| e.to_string())?.len() > MAX_INPUT {
            return Err("task input exceeds 64 KiB".into());
        }
        let fields = input.as_object().ok_or("task input must be an object")?;
        let allowed: &[&str] = match name {
            "TaskCreate" => &["subject", "description", "activeForm", "metadata"],
            "TaskGet" => &["taskId"],
            "TaskList" => &[],
            "TaskUpdate" => &[
                "taskId",
                "subject",
                "description",
                "activeForm",
                "status",
                "addBlocks",
                "addBlockedBy",
                "owner",
                "metadata",
            ],
            "TodoWrite" => &["todos"],
            _ => return Err(format!("unknown task tool: {name}")),
        };
        if let Some(field) = fields.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(format!("unsupported {name} field: {field}"));
        }
        let result = match name {
            "TaskCreate" => self.create(fields)?,
            "TaskGet" => self.get(fields)?,
            "TaskList" => self.list()?,
            "TaskUpdate" => self.update(fields)?,
            "TodoWrite" => self.todo_write(fields)?,
            _ => unreachable!(),
        };
        let output = serde_json::to_string(&result).map_err(|e| e.to_string())?;
        if output.len() > MAX_OUTPUT {
            return Err("task output exceeds 64 KiB".into());
        }
        Ok(output)
    }

    fn create(&self, fields: &Map<String, Value>) -> Result<Value, String> {
        let subject = required_text(fields, "subject")?.to_owned();
        let description = required_text(fields, "description")?.to_owned();
        let active_form = optional_text(fields, "activeForm")?.map(str::to_owned);
        let metadata = metadata(fields)?.unwrap_or_default();
        let mut state = self.state.lock().map_err(|_| "task board lock poisoned")?;
        if state.tasks.len() >= MAX_TASKS {
            return Err("session task limit reached".into());
        }
        let next_id = state
            .next_id
            .checked_add(1)
            .ok_or("task ID limit reached")?;
        let id = next_id.to_string();
        let task = Task {
            id: id.clone(),
            subject: subject.clone(),
            description,
            active_form,
            status: "pending".into(),
            owner: None,
            metadata,
            blocks: BTreeSet::new(),
            blocked_by: BTreeSet::new(),
        };
        // A successful create has a bounded response; a failed request does not mutate state.
        let result = json!({"task":{"id":id,"subject":subject}});
        ensure_output(&result)?;
        state.tasks.insert(id, task);
        state.next_id = next_id;
        Ok(result)
    }

    fn get(&self, fields: &Map<String, Value>) -> Result<Value, String> {
        let id = required_text(fields, "taskId")?;
        let state = self.state.lock().map_err(|_| "task board lock poisoned")?;
        Ok(json!({"task": state.tasks.get(id).map(|t| json!({
            "id":t.id,"subject":t.subject,"description":t.description,
            "status":t.status,"blocks":t.blocks,"blockedBy":t.blocked_by
        }))}))
    }

    fn list(&self) -> Result<Value, String> {
        let state = self.state.lock().map_err(|_| "task board lock poisoned")?;
        let tasks: Vec<Value> = state.tasks.values().map(|t| {
            let mut task = json!({"id":t.id,"subject":t.subject,"status":t.status,"blockedBy":t.blocked_by});
            if let Some(owner) = &t.owner { task["owner"] = json!(owner); }
            task
        }).collect();
        Ok(json!({"tasks":tasks}))
    }

    fn update(&self, fields: &Map<String, Value>) -> Result<Value, String> {
        let id = required_text(fields, "taskId")?.to_owned();
        let subject = optional_text(fields, "subject")?;
        let description = optional_text(fields, "description")?;
        let active_form = optional_text(fields, "activeForm")?;
        let owner = optional_text(fields, "owner")?;
        let status = optional_text(fields, "status")?;
        if let Some(value) = status
            && !matches!(value, "pending" | "in_progress" | "completed" | "deleted")
        {
            return Err("invalid status".into());
        }
        let blocks = id_list(fields, "addBlocks")?;
        let blocked_by = id_list(fields, "addBlockedBy")?;
        let changes = metadata(fields)?;
        let mut state = self.state.lock().map_err(|_| "task board lock poisoned")?;
        let original = state.tasks.get(&id).ok_or("task not found")?;
        let old_status = original.status.clone();
        if status == Some("deleted") {
            if fields.keys().any(|key| key != "taskId" && key != "status") {
                return Err("deleted status cannot be combined with other changes".into());
            }
            let result = json!({"success":true,"taskId":id,"updatedFields":["status"],"statusChange":{"from":old_status,"to":"deleted"}});
            ensure_output(&result)?;
            state.tasks.remove(&id);
            for task in state.tasks.values_mut() {
                task.blocks.remove(&id);
                task.blocked_by.remove(&id);
            }
            return Ok(result);
        }
        // Validate the entire change set before touching the live board.
        let mut candidate = original.clone();
        let mut updated_fields = Vec::new();
        for (key, value) in [
            ("subject", subject),
            ("description", description),
            ("activeForm", active_form),
            ("owner", owner),
        ] {
            if let Some(value) = value {
                match key {
                    "subject" => candidate.subject = value.to_owned(),
                    "description" => candidate.description = value.to_owned(),
                    "activeForm" => candidate.active_form = Some(value.to_owned()),
                    "owner" => candidate.owner = Some(value.to_owned()),
                    _ => unreachable!(),
                }
                updated_fields.push(key);
            }
        }
        if let Some(status) = status {
            candidate.status = status.into();
            updated_fields.push("status");
        }
        if let Some(changes) = changes {
            for (key, value) in changes {
                if value.is_null() {
                    candidate.metadata.remove(&key);
                } else {
                    candidate.metadata.insert(key, value);
                }
            }
            if serde_json::to_vec(&candidate.metadata)
                .map_err(|e| e.to_string())?
                .len()
                > MAX_METADATA
            {
                return Err("task metadata exceeds 16 KiB".into());
            }
            updated_fields.push("metadata");
        }
        let mut edges = Vec::new();
        if fields.contains_key("addBlocks") {
            updated_fields.push("addBlocks");
        }
        if fields.contains_key("addBlockedBy") {
            updated_fields.push("addBlockedBy");
        }
        for target in blocks {
            edges.push((id.clone(), target));
        }
        for source in blocked_by {
            edges.push((source, id.clone()));
        }
        for (source, target) in &edges {
            if source == target {
                return Err("task cannot depend on itself".into());
            }
            if !state.tasks.contains_key(source) || !state.tasks.contains_key(target) {
                return Err("dependency task not found".into());
            }
        }
        // The graph is tiny and bounded; testing candidate edges as a set makes
        // multi-edge updates atomic and prevents cycles even within one request.
        let mut adjacency: BTreeMap<String, BTreeSet<String>> = state
            .tasks
            .iter()
            .map(|(id, task)| (id.clone(), task.blocks.clone()))
            .collect();
        for (source, target) in &edges {
            adjacency
                .get_mut(source)
                .expect("validated source")
                .insert(target.clone());
        }
        if has_cycle(&adjacency) {
            return Err("dependency cycle".into());
        }
        let mut result = json!({"success":true,"taskId":id,"updatedFields":updated_fields});
        if let Some(status) = status
            && status != old_status
        {
            result["statusChange"] = json!({"from":old_status,"to":status});
        }
        ensure_output(&result)?;
        state.tasks.insert(id, candidate);
        for (source, target) in edges {
            state
                .tasks
                .get_mut(&source)
                .expect("validated source")
                .blocks
                .insert(target.clone());
            state
                .tasks
                .get_mut(&target)
                .expect("validated target")
                .blocked_by
                .insert(source);
        }
        Ok(result)
    }

    fn todo_write(&self, fields: &Map<String, Value>) -> Result<Value, String> {
        let todos = fields
            .get("todos")
            .and_then(Value::as_array)
            .ok_or("missing or invalid todos")?;
        if todos.len() > MAX_TODOS {
            return Err("session todo limit reached".into());
        }
        for todo in todos {
            let object = todo.as_object().ok_or("todo must be an object")?;
            if object.len() != 3
                || object
                    .keys()
                    .any(|key| !["content", "status", "activeForm"].contains(&key.as_str()))
            {
                return Err("todo must contain only content, status, activeForm".into());
            }
            required_text(object, "content")?;
            required_text(object, "activeForm")?;
            if !matches!(
                required_text(object, "status")?,
                "pending" | "in_progress" | "completed"
            ) {
                return Err("invalid todo status".into());
            }
        }
        let mut state = self.state.lock().map_err(|_| "task board lock poisoned")?;
        let result = json!({"oldTodos":state.todos,"newTodos":todos});
        ensure_output(&result)?;
        state.todos = todos.clone();
        Ok(result)
    }
}

fn required_text<'a>(fields: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    let value = fields
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing or invalid {key}"))?;
    if value.len() > MAX_TEXT {
        return Err(format!("{key} exceeds 8 KiB"));
    }
    Ok(value)
}

fn optional_text<'a>(fields: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    if fields.contains_key(key) {
        required_text(fields, key).map(Some)
    } else {
        Ok(None)
    }
}

fn metadata(fields: &Map<String, Value>) -> Result<Option<Map<String, Value>>, String> {
    let Some(value) = fields.get("metadata") else {
        return Ok(None);
    };
    let object = value.as_object().ok_or("metadata must be an object")?;
    if serde_json::to_vec(object).map_err(|e| e.to_string())?.len() > MAX_METADATA {
        return Err("metadata exceeds 16 KiB".into());
    }
    Ok(Some(object.clone()))
}

fn id_list(fields: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let Some(value) = fields.get(key) else {
        return Ok(Vec::new());
    };
    let list = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if list.len() > MAX_TASKS {
        return Err(format!("{key} exceeds task limit"));
    }
    list.iter()
        .map(|entry| {
            entry
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= MAX_TEXT)
                .map(str::to_owned)
                .ok_or_else(|| format!("{key} must contain task IDs"))
        })
        .collect()
}

fn ensure_output(value: &Value) -> Result<(), String> {
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_OUTPUT {
        return Err("task output exceeds 64 KiB".into());
    }
    Ok(())
}

fn has_cycle(edges: &BTreeMap<String, BTreeSet<String>>) -> bool {
    fn visit(
        id: &str,
        edges: &BTreeMap<String, BTreeSet<String>>,
        marks: &mut BTreeMap<String, u8>,
    ) -> bool {
        match marks.get(id) {
            Some(1) => return true,
            Some(2) => return false,
            _ => {}
        }
        marks.insert(id.to_owned(), 1);
        if let Some(targets) = edges.get(id) {
            for target in targets {
                if visit(target, edges, marks) {
                    return true;
                }
            }
        }
        marks.insert(id.to_owned(), 2);
        false
    }
    let mut marks = BTreeMap::new();
    edges.keys().any(|id| visit(id, edges, &mut marks))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(board: &ClaudeTasks, tool: &str, input: Value) -> Value {
        serde_json::from_str(&board.execute(tool, input).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn create_get_list_update_delete_and_isolation() {
        let board = ClaudeTasks::new();
        assert_eq!(ClaudeTasks::definitions().len(), 5);
        assert_eq!(run(&board, "TaskCreate", json!({"subject":"first","description":"details","activeForm":"working","metadata":{"retain":1,"drop":2}})).await["task"]["id"], "1");
        assert_eq!(
            run(
                &board,
                "TaskCreate",
                json!({"subject":"second","description":"more"})
            )
            .await["task"]["id"],
            "2"
        );
        let clone = board.clone();
        assert_eq!(
            run(&clone, "TaskGet", json!({"taskId":"1"})).await["task"]["description"],
            "details"
        );
        assert_eq!(run(&clone, "TaskUpdate", json!({"taskId":"1","subject":"renamed","status":"in_progress","owner":"worker","metadata":{"drop":null,"other":3},"addBlocks":["2"]})).await["statusChange"], json!({"from":"pending","to":"in_progress"}));
        assert_eq!(
            run(&board, "TaskGet", json!({"taskId":"2"})).await["task"]["blockedBy"],
            json!(["1"])
        );
        assert_eq!(
            run(&board, "TaskList", json!({})).await["tasks"][0]["owner"],
            "worker"
        );
        assert_eq!(
            run(
                &board,
                "TaskUpdate",
                json!({"taskId":"1","status":"deleted"})
            )
            .await["success"],
            true
        );
        assert_eq!(
            run(&board, "TaskGet", json!({"taskId":"1"})).await["task"],
            Value::Null
        );
        assert_eq!(
            run(&board, "TaskGet", json!({"taskId":"2"})).await["task"]["blockedBy"],
            json!([])
        );
        assert_eq!(
            run(&ClaudeTasks::new(), "TaskList", json!({})).await["tasks"],
            json!([])
        );
    }

    #[tokio::test]
    async fn rejects_cycles_and_invalid_dependencies_without_partial_updates() {
        let board = ClaudeTasks::new();
        for subject in ["a", "b", "c"] {
            run(
                &board,
                "TaskCreate",
                json!({"subject":subject,"description":"d"}),
            )
            .await;
        }
        run(
            &board,
            "TaskUpdate",
            json!({"taskId":"1","addBlocks":["2"]}),
        )
        .await;
        assert!(
            board
                .execute(
                    "TaskUpdate",
                    json!({"taskId":"2","subject":"should not persist","addBlocks":["3","1"]})
                )
                .await
                .unwrap_err()
                .contains("cycle")
        );
        assert_eq!(
            run(&board, "TaskGet", json!({"taskId":"2"})).await["task"]["subject"],
            "b"
        );
        assert!(
            board
                .execute(
                    "TaskUpdate",
                    json!({"taskId":"3","addBlockedBy":["missing"]})
                )
                .await
                .is_err()
        );
        assert!(
            board
                .execute("TaskUpdate", json!({"taskId":"3","addBlocks":["3"]}))
                .await
                .is_err()
        );
        run(
            &board,
            "TaskUpdate",
            json!({"taskId":"2","addBlockedBy":["3"]}),
        )
        .await;
        assert!(
            board
                .execute("TaskUpdate", json!({"taskId":"2","addBlocks":["3"]}))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn todo_replacement_and_validation() {
        let board = ClaudeTasks::new();
        let first = json!({"content":"a","status":"pending","activeForm":"doing a"});
        assert_eq!(
            run(&board, "TodoWrite", json!({"todos":[first]})).await["oldTodos"],
            json!([])
        );
        assert_eq!(
            run(&board, "TodoWrite", json!({"todos":[]})).await["oldTodos"],
            json!([first])
        );
        for input in [
            json!({"todos":[{"content":"bad","status":"unknown","activeForm":"doing"}]}),
            json!({"todos":[{"content":"bad","status":"pending"}]}),
            json!({"todos":null}),
        ] {
            assert!(board.execute("TodoWrite", input).await.is_err());
        }
        assert!(
            board
                .execute(
                    "TaskCreate",
                    json!({"subject":"x","description":"y","metadata":null})
                )
                .await
                .is_err()
        );
        assert!(
            board
                .execute("TaskUpdate", json!({"taskId":"none","status":"deleted"}))
                .await
                .is_err()
        );
        assert_eq!(
            run(&board, "TodoWrite", json!({"todos":[]})).await["oldTodos"],
            json!([])
        );
    }
}
