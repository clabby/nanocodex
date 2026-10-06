use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

use nanocodex_agent::{
    PromptRequest,
    execution::{
        ExecutionAdmission, ExecutionFuture, ExecutionOutput, ExecutionPolicy,
        ExecutionStepAdmission,
    },
    session::SessionSnapshot,
};
use nanocodex_oai_tools::{
    Tool, ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolResult, contract::async_trait,
};

use super::*;

struct RevisionProbe {
    seen: tokio::sync::mpsc::UnboundedSender<Option<u64>>,
    release: Arc<tokio::sync::Semaphore>,
}

#[async_trait]
impl Tool for RevisionProbe {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(
            "revision_probe",
            "Records the originating instruction revision.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    async fn execute(&self, _input: ToolInput, context: ToolContext<'_>) -> ToolResult {
        self.seen.send(context.instruction_revision()).unwrap();
        self.release.acquire().await.unwrap().forget();
        Ok(ToolOutput::text("observed"))
    }
}

struct ProviderSteps {
    saved: Mutex<Option<nanocodex_agent::execution::ExecutionContinuation>>,
    interrupt: AtomicBool,
    completed: Mutex<Option<(SessionSnapshot, ExecutionOutput)>>,
}

impl ProviderSteps {
    const fn new() -> Self {
        Self {
            saved: Mutex::new(None),
            interrupt: AtomicBool::new(true),
            completed: Mutex::new(None),
        }
    }
}

impl ExecutionPolicy for ProviderSteps {
    fn continuation<'a>(
        &'a self,
        _operation_id: String,
    ) -> ExecutionFuture<
        'a,
        nanocodex_agent::Result<Option<nanocodex_agent::execution::ExecutionContinuation>>,
    > {
        Box::pin(async { Ok(self.saved.lock().unwrap().take()) })
    }
    fn advance<'a>(
        &'a self,
        _operation_id: String,
        state: nanocodex_agent::execution::ExecutionContinuation,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async move {
            *self.saved.lock().unwrap() = Some(state);
            Ok(())
        })
    }

    fn admit<'a>(
        &'a self,
        _operation_id: String,
        _input_json: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<ExecutionAdmission>> {
        Box::pin(async {
            if let Some((snapshot, output)) = self.completed.lock().unwrap().clone() {
                return Ok(ExecutionAdmission::Completed { snapshot, output });
            }
            if self.saved.lock().unwrap().is_some() {
                return Ok(ExecutionAdmission::Resume);
            }
            Ok(ExecutionAdmission::Execute)
        })
    }

    fn admit_automatic<'a>(
        &'a self,
        candidate_operation_id: String,
        _input_json: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<(String, ExecutionAdmission)>> {
        Box::pin(async move { Ok((candidate_operation_id, ExecutionAdmission::Execute)) })
    }

    fn release<'a>(&'a self, _operation_id: String) -> ExecutionFuture<'a, ()> {
        Box::pin(async {})
    }

    fn cancel<'a>(
        &'a self,
        _operation_id: String,
        _snapshot: Option<SessionSnapshot>,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn begin_attempt<'a>(
        &'a self,
        _operation_id: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn begin_step<'a>(
        &'a self,
        _operation_id: String,
        _step_id: String,
        kind: String,
        _input_json: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<ExecutionStepAdmission>> {
        Box::pin(async move {
            let revision = self.saved.lock().unwrap().as_ref().and_then(|saved| {
                serde_json::from_str::<Value>(&saved.state_json).unwrap()["instruction_revision"]
                    .as_u64()
            });
            if kind == "model_call"
                && revision == Some(2)
                && self.interrupt.swap(false, Ordering::SeqCst)
            {
                return Err(NanocodexError::ExecutionPolicyOwnerStopped);
            }
            Ok(ExecutionStepAdmission::Execute)
        })
    }

    fn complete_step<'a>(
        &'a self,
        _operation_id: String,
        _step_id: String,
        _output_json: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async move { Ok(()) })
    }

    fn complete<'a>(
        &'a self,
        _operation_id: String,
        snapshot: SessionSnapshot,
        output: ExecutionOutput,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async move {
            *self.completed.lock().unwrap() = Some((snapshot, output));
            Ok(())
        })
    }

    fn fail_attempt<'a>(
        &'a self,
        _operation_id: String,
        _error: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn fail<'a>(
        &'a self,
        _operation_id: String,
        _snapshot: SessionSnapshot,
        _error: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn accept_steer<'a>(
        &'a self,
        _operation_id: String,
        _accepted_after_model_call_index: u32,
        _input_json: String,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<u32>> {
        Box::pin(async { Ok(1) })
    }
    fn bind_steer<'a>(
        &'a self,
        _operation_id: String,
        _steer_index: u32,
        _model_call_index: u32,
    ) -> ExecutionFuture<'a, nanocodex_agent::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn captured_tier_and_consumed_instruction_revision_survive_recovery_and_completed_replay()
-> Result<()> {
    timeout(std::time::Duration::from_secs(15), async {
        let policy = Arc::new(ProviderSteps::new());
        let generations = Arc::new(AtomicU32::new(0));
        let (seen, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let workspace = tempfile::tempdir()?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let provider_calls = generations.clone();
        let (replay_finished, replay_finished_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 1..=3 {
                let request = next_http_json(&listener).await?;
                provider_calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(request.body["model"], Model::Astra.as_str());
                assert_eq!(request.body["service_tier"], "ultrafast");
                if index > 1 {
                    assert!(request.body.to_string().contains("consumed steering"));
                }
                if index < 3 {
                    let event = completed_response(
                        &format!("resp-revision-tool-{index}"),
                        &[json!({
                            "type": "function_call", "call_id": format!("call-revision-{index}"),
                            "name": "revision_probe", "arguments": "{}"
                        })],
                    );
                    send_http_events(request.stream, [event]).await?;
                } else {
                    assert!(
                        request.body["input"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|item| {
                                item["type"] == "function_call_output"
                                    && item["call_id"] == "call-revision-2"
                            })
                    );
                    send_http_final(request.stream, "resp-revision-complete").await?;
                }
                requests.push(request.body);
            }
            replay_finished_rx
                .await
                .map_err(|_| eyre!("completed replay signal dropped"))?;
            let extra = timeout(std::time::Duration::from_millis(200), listener.accept()).await;
            assert!(extra.is_err(), "completed replay contacted the provider");
            Ok::<_, eyre::Report>(requests)
        });
        let build = |tier| -> Result<_> {
            let openai = OpenAi::builder("test-key")
                .model(Model::Astra)
                .service_tier(tier)
                .transport(ResponsesTransport::Https)
                .api_base_url(endpoint.clone())
                .build()?;
            Nanocodex::builder(openai)
                .workspace(workspace.path())
                .execution_policy(policy.clone())
                .tools(
                    Tools::builder()
                        .without_defaults()
                        .tool(RevisionProbe {
                            seen: seen.clone(),
                            release: release.clone(),
                        })
                        .build()?,
                )
                .build()
                .map_err(Into::into)
        };
        let original = || {
            PromptRequest::new(Prompt::new("original revision").with_instruction_revision(1))
                .request_id("revision-recovery")
        };
        let (agent, events) = build(ServiceTier::Ultrafast)?;
        drop(events);
        let turn = agent.prompt(original()).await?;
        assert_eq!(observed.recv().await, Some(Some(1)));
        turn.steer(Prompt::new("consumed steering").with_instruction_revision(2))
            .await?;
        release.add_permits(1);
        assert!(matches!(
            turn.await,
            Err(NanocodexError::ExecutionPolicyOwnerStopped)
        ));
        {
            let saved = policy.saved.lock().unwrap();
            let saved = saved.as_ref().unwrap();
            let state: Value = serde_json::from_str(&saved.state_json)?;
            assert_eq!(state["instruction_revision"], 2);
            assert_eq!(state["service_tier"], "ultrafast");
            assert!(serde_json::to_string(&saved.history)?.contains("consumed steering"));
        }
        assert_eq!(generations.load(Ordering::SeqCst), 1);
        drop(agent);
        let (recovered, events) = build(ServiceTier::Standard)?;
        drop(events);
        let resumed = recovered.prompt(original()).await?;
        assert_eq!(
            observed.recv().await,
            Some(Some(2)),
            "saved consumed revision must override replayed prompt revision 1"
        );
        release.add_permits(1);
        let completed = resumed.await?;
        assert_eq!(completed.final_message(), "done");
        assert_eq!(
            completed
                .usage()
                .unwrap()
                .estimated_cost()
                .unwrap()
                .service_tier(),
            ServiceTier::Ultrafast
        );
        assert_eq!(generations.load(Ordering::SeqCst), 3);
        recovered.shutdown().await?;
        drop(recovered);
        let (replayed, events) = build(ServiceTier::Standard)?;
        drop(events);
        let replayed_result = replayed.prompt(original()).await?.result().await?;
        assert_eq!(replayed_result.final_message(), completed.final_message());
        assert_eq!(
            serde_json::to_value(replayed_result.usage())?,
            serde_json::to_value(completed.usage())?
        );
        assert_eq!(generations.load(Ordering::SeqCst), 3);
        assert!(matches!(
            observed.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        replayed.shutdown().await?;
        replay_finished
            .send(())
            .map_err(|()| eyre!("completed replay signal receiver dropped"))?;
        let requests = server.await??;
        if let Some(path) = std::env::var_os("NANOCODEX_E2E_TRANSCRIPT") {
            std::fs::write(path, serde_json::to_string_pretty(&requests)?)?;
        }
        Ok::<_, eyre::Report>(())
    })
    .await?
}
