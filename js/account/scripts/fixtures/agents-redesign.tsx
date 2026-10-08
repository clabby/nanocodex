// Synthetic /agents workspace for the redesign journey: the real sidebar, the real
// terminal view and controller, and a scripted Agent that records submitted input.
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AgentTerminalView } from "../../../nanocodex-terminal/src/AgentTerminalView";
import { AgentSidebar } from "../../src/AgentSidebar";
import "../../src/index.css";
import "../../../nanocodex-terminal/styles.css";
import "../../src/Home.css";
import "../../src/AgentTerminal.css";

type Event = { request_id: string; seq: number; type: string; payload: Record<string, unknown> };
const session = "agents-redesign";
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): Event => ({ request_id: session, seq: ++seq, type, payload });
let onEvent: (event: Event) => void = () => {};
const prompts: unknown[] = [];
const cancels: number[] = [];
let queue: Event[] = [];
let settle: { resolve(value: unknown): void; reject(error: unknown): void } | undefined;
let finalMessage = "";
let failure: Error | undefined;

function script(turn: string, text: string): Event[] {
  const now = Date.now();
  if (text === "fail") {
    failure = new Error('Request failed (500): {"error":{"message":"Upstream model is overloaded","type":"server_error","code":"overloaded"}}\n    at fetchModel (worker.js:120:15)\n    at async runTurn (worker.js:88:3)');
    return [ev("run.started", { turn_id: turn })];
  }
  if (text === "envelope") {
    finalMessage = JSON.stringify([{ type: "output_text", text: "The envelope answer, shown as prose.", annotations: [] }]);
    return [ev("run.started", { turn_id: turn }), ev("assistant.message", { turn_id: turn, item_id: "env", text: finalMessage }), ev("run.completed", { turn_id: turn })];
  }
  if (text.startsWith("attach")) {
    finalMessage = "Received your attachments.";
    return [ev("run.started", { turn_id: turn }), ev("assistant.message", { turn_id: turn, item_id: `a-${turn}`, text: finalMessage }), ev("run.completed", { turn_id: turn })];
  }
  finalMessage = "## Release check\n\nThe suite passes except one **flaky** test.\n\n| Check | State |\n| --- | --- |\n| build | ok |\n| tests | 1 failing |\n\n```ts\nexport const ready = await checks.pass();\n```";
  const events = [ev("run.started", { turn_id: turn })];
  for (const word of "Reading the release module and running the suite.".split(" "))
    events.push(ev("reasoning.summary.delta", { turn_id: turn, item_id: `r-${turn}`, text: `${word} ` }));
  events.push(ev("tool.call", { turn_id: turn, call_id: `${turn}-cmd`, tool: "exec_command", arguments: { cmd: "pnpm test --watch=false" }, managed_event_created_at: now }));
  events.push(ev("tool.result", { turn_id: turn, call_id: `${turn}-cmd`, tool: "exec_command", status: "completed", result: { exit_code: 0, output: "ok 1 release\nok 2 rollout" }, duration_ns: 3e9, managed_event_created_at: now + 3000 }));
  events.push(ev("tool.call", { turn_id: turn, call_id: `${turn}-read`, tool: "Read", arguments: { file_path: "src/release.ts" }, managed_event_created_at: now + 3100 }));
  events.push(ev("tool.result", { turn_id: turn, call_id: `${turn}-read`, tool: "Read", status: "completed", result: "export const ready = false;", duration_ns: 1e8 }));
  events.push(ev("tool.call", { turn_id: turn, call_id: `${turn}-fail`, tool: "exec_command", arguments: { cmd: "pnpm test release.test.ts" }, managed_event_created_at: now + 3300 }));
  events.push(ev("tool.result", { turn_id: turn, call_id: `${turn}-fail`, tool: "exec_command", status: "failed", result: { exit_code: 1, output: "FAIL release.test.ts\nTypeError: ready is not a function\n    at Object.<anonymous> (release.test.ts:4:9)" }, duration_ns: 2e9 }));
  for (let i = 0; i < finalMessage.length; i += 16) events.push(ev("assistant.delta", { turn_id: turn, item_id: `a-${turn}`, text: finalMessage.slice(i, i + 16) }));
  events.push(ev("assistant.message", { turn_id: turn, item_id: `a-${turn}`, text: finalMessage }));
  events.push(ev("run.completed", { turn_id: turn }));
  return events;
}

const agent = {
  sessionId: session,
  events: { watch: () => ({
    onEvent(listener: typeof onEvent) { onEvent = listener; return () => { onEvent = () => {}; }; },
    onHistory() { return () => {}; },
    off() {},
  }) },
  turn: { prompt: ({ input }: { input: unknown }) => {
    prompts.push(input);
    const turn = `turn-${prompts.length}`;
    const text = typeof input === "string" ? input : "attach";
    failure = undefined;
    queue = script(turn, text);
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    return { steer: async () => {}, cancel: async () => { cancels.push(prompts.length); fixture.drain(); },
      result: () => result, dispose() {} };
  } },
};

/** The journey paces the scripted turn: play(n) emits n events; drain() finishes it. */
const fixture = {
  prompts, cancels,
  pending: () => queue.length,
  play(count = 1) { for (const event of queue.splice(0, count)) onEvent(event); },
  drain() {
    fixture.play(queue.length);
    const current = settle; settle = undefined;
    if (!current) return;
    if (failure) {
      onEvent(ev("run.failed", { status: "failed" }));
      current.reject(failure);
    } else current.resolve({ finalMessage, dispose() {} });
  },
};
(window as any).fixture = fixture;

const conversations = [
  { id: "one", title: "Fix the release check", lastUserMessageAt: Date.now() - 60_000, presentation: { status: "running", activeTurnIds: ["a"], activityTurnId: "a", activity: "Running tests", lastUserPrompt: "Fix the release check" } },
  { id: "two", title: "Review deployment changes", lastUserMessageAt: Date.now() - 3_600_000, presentation: { status: "completed", activeTurnIds: [], lastUserPrompt: "Review the deploy diff" } },
  { id: "three", title: "Repair failing build", lastUserMessageAt: Date.now() - 86_400_000 * 2, presentation: { status: "failed", activeTurnIds: [] } },
];

function Workspace() {
  const [open, setOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return <div className="nanocodex-demo chat-workspace is-full" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <div className="conversation-workspace">
      <AgentSidebar active conversations={conversations as any} landing={false} collapsed={false} open={open} persistent pending={false}
        selectedId="one" triggerRef={{ current: null }} runningOnly={false} onRunningOnlyChange={() => {}}
        onClose={close} onCollapse={() => {}} onCreate={() => {}} onRetry={() => {}} onSelect={() => {}} onPrefetch={() => {}} />
      <div className="conversation-main">
        <header className="agent-chat-header">
          <button className="agent-sidebar-toggle chat-icon-button" type="button" aria-label="Open sidebar" onClick={() => setOpen(true)}>☰</button>
          <div className="agent-chat-heading"><strong>Fix the release check</strong></div>
          <div className="agent-chat-header-actions"><button className="chat-running-agents" type="button"><span className="chat-running-dot" />1</button>
            <div className={`agent-chat-secondary${menuOpen ? " is-open" : ""}`} onClick={() => setMenuOpen(false)}>
              {["New team session", "Share thread", "Inspect", "Light appearance"].map(label => <button key={label} className="chat-icon-button" type="button" aria-label={label}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" /><span>{label}</span></button>)}
            </div>
            {menuOpen && <div className="agent-chat-menu-backdrop" onClick={() => setMenuOpen(false)} />}
            <button className="chat-icon-button agent-chat-more" type="button" aria-label="More actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>⋯</button>
            <button className="chat-icon-button" type="button" aria-label="New agent">+</button></div>
        </header>
        <AgentTerminalView agent={agent as any} agentError={undefined} attachments={{ documents: true }} mode="full" voice
          controls={() => <div className="agent-runtime-controls"><button type="button" className="agent-model-trigger" aria-label="Model settings: Opus 5.5, Medium">
            <span>Opus 5.5</span><span className="agent-model-effort">Medium</span></button></div>}
          onConversationActivity={() => {}} onStateChange={() => {}} retryAgent={() => {}} promptIntent="queue" composerPlaceholder="Ask Nanocodex" />
        <p className="agent-chat-footnote">Your agent keeps working when you leave.</p>
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><Workspace /></MemoryRouter>);
