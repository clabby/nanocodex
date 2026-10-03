//! Boundary scenarios, written before implementation. Failure modes: ignored
//! model fields, flattened UI choices, invented lifecycle receipts, dropped
//! session/call identity, and stale/replaced MCP catalogs. Isolation is needed
//! because the embedding owns UI, child execution, and server authorization.
use super::*;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

const fn context(call: &str) -> HostContext<'_> {
    HostContext::new("claude", "session-a", call, 4096).with_turn_id(Some("turn-a"))
}

struct InteractiveHost {
    questions: mpsc::UnboundedSender<(QuestionsRequest, oneshot::Sender<String>)>,
}
impl ClaudeHost for InteractiveHost {
    async fn execute(
        &self,
        request: HostRequest,
        context: HostContext<'_>,
    ) -> Result<ToolOutput, String> {
        assert_eq!(context.session_id(), "session-a");
        assert_eq!(context.turn_id(), Some("turn-a"));
        assert_eq!(context.call_id(), "question-1");
        let HostRequest::AskUserQuestion(request) = request else {
            return Err("unsupported".into());
        };
        let (answer, received) = oneshot::channel();
        self.questions
            .send((request, answer))
            .map_err(|e| e.to_string())?;
        let answer = received.await.map_err(|e| e.to_string())?;
        Ok(ToolOutput::text(answer))
    }
}

#[tokio::test]
async fn questions_remain_pending_and_preserve_choices_until_host_answers() {
    let (send, mut receive) = mpsc::unbounded_channel();
    let adapter = ClaudeHostTools::new(
        InteractiveHost { questions: send },
        [HostTool::AskUserQuestion],
    );
    let request = json!({"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Blue","description":"Ocean","markdown":"**Preview**"},{"label":"Green","description":"Forest"}],"multiSelect":true}]});
    let pending = adapter.execute("AskUserQuestion", request.clone(), context("question-1"));
    tokio::pin!(pending);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), &mut pending)
            .await
            .is_err()
    );
    let (received, answer) = receive.recv().await.unwrap();
    assert_eq!(serde_json::to_value(received).unwrap(), request);
    answer.send("Blue, Green".into()).unwrap();
    let result = pending.await.unwrap();
    assert!(!result.is_error);
    assert_eq!(result.structured_result.unwrap(), json!("Blue, Green"));
}

struct TaskHost {
    state: Arc<Mutex<TaskState>>,
}
#[derive(Default)]
struct TaskState {
    stop: Option<oneshot::Sender<()>>,
    status: Option<&'static str>,
    calls: usize,
}
impl ClaudeHost for TaskHost {
    async fn execute(
        &self,
        request: HostRequest,
        _: HostContext<'_>,
    ) -> Result<ToolOutput, String> {
        self.state.lock().unwrap().calls += 1;
        match request {
            HostRequest::Agent(request) => {
                assert!(request.run_in_background);
                let (stop, cancelled) = oneshot::channel();
                {
                    let mut state = self.state.lock().unwrap();
                    state.stop = Some(stop);
                    state.status = Some("running");
                }
                let state = Arc::clone(&self.state);
                tokio::spawn(async move {
                    cancelled.await.unwrap();
                    state.lock().unwrap().status = Some("stopped");
                });
                Ok(ToolOutput::text("host-task-17"))
            }
            HostRequest::TaskOutput(request) => {
                if request.task_id != "host-task-17" {
                    return Err("unknown host task".into());
                }
                assert!(!request.block);
                Ok(ToolOutput::text(
                    self.state.lock().unwrap().status.unwrap_or("missing"),
                ))
            }
            HostRequest::TaskStop(request) => {
                if request.task_id != "host-task-17" {
                    return Err("unknown host task".into());
                }
                let stop = self
                    .state
                    .lock()
                    .unwrap()
                    .stop
                    .take()
                    .ok_or("already stopped")?;
                stop.send(()).map_err(|_| "task gone")?;
                loop {
                    if self.state.lock().unwrap().status == Some("stopped") {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                Ok(ToolOutput::text("stopped"))
            }
            _ => Err("unsupported".into()),
        }
    }
}

#[tokio::test]
async fn background_task_identity_and_stop_are_owned_by_host() {
    let state = Arc::new(Mutex::new(TaskState::default()));
    let adapter = ClaudeHostTools::new(
        TaskHost {
            state: state.clone(),
        },
        [HostTool::Agent, HostTool::TaskOutput, HostTool::TaskStop],
    );
    let agent = json!({"prompt":"wait for cancellation","description":"Wait","subagent_type":"general-purpose","run_in_background":true});
    let started = adapter
        .execute("Agent", agent, context("start"))
        .await
        .unwrap();
    assert_eq!(started.structured_result.unwrap(), json!("host-task-17"));
    let read = json!({"task_id":"host-task-17","block":false,"timeout":10});
    assert_eq!(
        adapter
            .execute("TaskOutput", read.clone(), context("read"))
            .await
            .unwrap()
            .structured_result
            .unwrap(),
        json!("running")
    );
    assert!(
        adapter
            .execute("TaskStop", json!({"task_id":"wrong"}), context("bad-stop"))
            .await
            .is_err()
    );
    assert_eq!(
        adapter
            .execute(
                "TaskStop",
                json!({"task_id":"host-task-17"}),
                context("stop")
            )
            .await
            .unwrap()
            .structured_result
            .unwrap(),
        json!("stopped")
    );
    assert_eq!(
        adapter
            .execute("TaskOutput", read, context("read-final"))
            .await
            .unwrap()
            .structured_result
            .unwrap(),
        json!("stopped")
    );
    assert_eq!(state.lock().unwrap().calls, 5);
}

struct RefusingHost(Mutex<Vec<HostRequest>>);
impl ClaudeHost for RefusingHost {
    async fn execute(
        &self,
        request: HostRequest,
        _: HostContext<'_>,
    ) -> Result<ToolOutput, String> {
        self.0.lock().unwrap().push(request);
        Err("host approval denied".into())
    }
}

#[tokio::test]
async fn invalid_or_unavailable_requests_never_reach_host_and_denials_are_not_success() {
    let adapter = ClaudeHostTools::new(RefusingHost(Mutex::new(vec![])), HostTool::ALL);
    for (name, request) in [
        (
            "Agent",
            json!({"prompt":"go","description":"Go","subagent_type":"general","mode":"bypassPermissions"}),
        ),
        ("TaskOutput", json!({"task_id":"x","timeout":600001})),
        ("TaskStop", json!({"task_id":"x","shellId":"other"})),
        (
            "AskUserQuestion",
            json!({"questions":[{"question":"q","header":"h","options":[{"label":"A","description":"a","execute":"bad"},{"label":"B","description":"b"}],"multiSelect":false}]}),
        ),
        ("AskUserQuestion", json!({"questions":[]})),
        ("EnterPlanMode", json!({"permission":"auto"})),
        (
            "ExitPlanMode",
            json!({"allowedPrompts":[{"tool":"Bash","prompt":"build","approved":true}]}),
        ),
        ("EnterWorktree", json!({"name":"one","path":"/other"})),
        ("ExitWorktree", json!({"action":"remove","force":true})),
        ("exec_command", json!({"cmd":"bad"})),
    ] {
        assert!(
            adapter
                .execute(name, request, context("invalid"))
                .await
                .is_err(),
            "accepted {name}"
        );
    }
    assert!(adapter.host.0.lock().unwrap().is_empty());
    for (name, request) in [
        ("EnterPlanMode", json!({})),
        (
            "ExitPlanMode",
            json!({"allowedPrompts":[{"tool":"Bash","prompt":"cargo test"}]}),
        ),
        ("EnterWorktree", json!({"path":"/approved/worktree"})),
        ("ExitWorktree", json!({"action":"keep"})),
    ] {
        assert_eq!(
            adapter
                .execute(name, request, context("denied"))
                .await
                .err()
                .unwrap(),
            "host approval denied"
        );
    }
    assert_eq!(adapter.host.0.lock().unwrap().len(), 4);
    let unavailable = ClaudeHostTools::new(RefusingHost(Mutex::new(vec![])), [HostTool::Agent]);
    assert_eq!(unavailable.definitions().len(), 1);
    assert!(unavailable.execute("Agent", json!({"prompt":"go","description":"Go","subagent_type":"general","run_in_background":true}), context("no-lifecycle")).await.is_err());
    assert!(
        unavailable
            .execute("TaskStop", json!({"task_id":"x"}), context("absent"))
            .await
            .is_err()
    );
    assert!(unavailable.host.0.lock().unwrap().is_empty());
}
