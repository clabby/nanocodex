import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AccountHostedTools, AccountHostedToolsProvider } from "../src/account-hosted-tools";
import { screenAction, screenResult } from "../src/hand-remote-agent";
import { createNamespaceExecutionRuntime } from "../src/namespace-tools";
import { CUA_JS_NAME, CUA_RESET_NAME } from "nanocodex-computer/contract";

const owner = "11111111-1111-4111-8111-111111111193";
const other = "22222222-2222-4222-8222-222222222293";
const surface = { id: "desktop", name: "Desktop", kind: "vm", width: 1600, height: 900, controllable: true, agent_tools: true, transport: "frames-v1" };
const observation = { schemaVersion: 1 as const, capturedAt: 1000, providers: [
  { id: "accessibility", status: "ok" as const, capturedAt: 999, ageMs: 1, freshness: "fresh" as const, scope: "requested_context" as const, foreground_verified: false, data: { role: "window", text: "Visible app state" } },
  { id: "external:0", status: "timeout" as const, capturedAt: 1000, freshness: "unknown" as const, error: "Provider timed out" },
] };
const target = { ...surface, machine_id: "test", machine_name: "Test", generation: "generation" };
const namespace = () => (env as unknown as { NANOCODEX_ACCOUNT_TOOLS: DurableObjectNamespace<AccountHostedTools> }).NANOCODEX_ACCOUNT_TOOLS;
function next(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error("No host message")); }, 2000);
    function receive(event: MessageEvent) { clearTimeout(timer); socket.removeEventListener("message", receive); resolve(JSON.parse(String(event.data))); }
    socket.addEventListener("message", receive);
  });
}
async function host(machine: string, recording: boolean | Record<string, unknown> = false, controllable = true) {
  const stub = namespace().getByName(owner);
  const response = await stub.fetch("https://account-tools.internal/hands/host", { headers: { "x-nanocodex-owner-id": owner, upgrade: "websocket" } });
  const socket = response.webSocket!, ready = next(socket); socket.accept(); const state = await ready;
  const published = next(socket); socket.send(JSON.stringify({ type: "catalog", machine_id: machine, machine_name: machine, surfaces: [{ ...surface, controllable, ...(typeof recording === "object" ? { recording: recording.available, recordingCapabilities: recording } : recording ? { recording } : {}) }] })); await published;
  const snapshot = await stub.fetch("https://account-tools.internal/snapshot", { method: "POST", body: JSON.stringify({ owner_id: owner }) });
  const catalog: any = await snapshot.json();
  const tool = catalog.tools.find((tool: any) => tool.route_token.includes(machine));
  return { stub, socket, state, tool };
}
describe("agent screen protocol", () => {
  it("discovers native CUA and joins the viewer on a live Hand, preserving grants and reconnect fences", async () => {
    const connected = await host("wayland-computer");
    let allowed = true;
    const provider = new AccountHostedToolsProvider(namespace(), owner, () => allowed);
    await provider.refresh();
    const machine = provider.screenMachines().find(machine => machine.id === "wayland-computer")!;
    expect(machine.capabilities).toEqual(["computer", "screen"]);
    expect(provider.machineOnline(machine.id)).toBe(true);
    const runtime = createNamespaceExecutionRuntime(() => [machine], () => undefined, undefined,
      (id, context) => provider.screenTool(id, context));
    const context = { sessionId: "screen-session", callId: "screen-call", parentCallId: "cell", model: "fixture", signal: new AbortController().signal };
    expect(runtime.tools).not.toHaveProperty("computer");
    const cua = runtime.tools[CUA_JS_NAME]!;
    const reset = runtime.tools[CUA_RESET_NAME]!;
    // Workdir-only discovery is the agent's first operation, not a direct
    // invocation of the internal screen adapter that bypasses its contract.
    expect(await cua.handler({ workdir: "/wayland-computer" }, context)).toMatchObject({
      definitions: [
        { name: CUA_JS_NAME, description: expect.stringContaining("Native screen control fallback"),
          parameters: { required: ["action"], properties: { action: { enum: expect.arrayContaining(["observe", "click"]) } } } },
        { name: CUA_RESET_NAME, parameters: { type: "object", additionalProperties: false } },
      ],
    });
    // The human viewer joins the very same publication, without another setup
    // or provider attachment. This is a real DO/WebSocket frame transport.
    const viewerJoined = next(connected.socket);
    const viewerResponse = await connected.stub.fetch(
      `https://account-tools.internal/hands/view?machine_id=${machine.id}&surface_id=desktop&generation=${connected.state.generation}`,
      { headers: { "x-nanocodex-owner-id": owner, upgrade: "websocket" } },
    );
    expect(viewerResponse.status).toBe(101);
    const viewer = viewerResponse.webSocket!, viewerReady = next(viewer);
    viewer.accept();
    const viewerState = await viewerReady;
    expect(await viewerJoined).toMatchObject({ type: "viewer", viewer_id: viewerState.connection_id, surface_id: "desktop" });
    const frameRequest = next(connected.socket);
    viewer.send(JSON.stringify({ type: "frame_request" }));
    expect(await frameRequest).toEqual({ type: "frame_request", viewer_id: viewerState.connection_id });
    const viewerFrame = next(viewer);
    connected.socket.send(JSON.stringify({ type: "frame", viewer_id: viewerState.connection_id, jpeg: "/9j/2Q==", width: 1, height: 1 }));
    expect(await viewerFrame).toEqual({ type: "frame", jpeg: "/9j/2Q==", width: 1, height: 1 });
    const requested = next(connected.socket);
    const selector = { app: "Example", window: "Window" };
    const pending = cua.handler({ workdir: "/wayland-computer", action: "observe", context: selector }, context);
    const request = await requested;
    expect(request).toMatchObject({ type: "agent_call", surface_id: "desktop", input: { action: "observe", context: selector } });
    connected.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: "ok", jpeg: "/9j/2Q==", width: 1, height: 1, observation }));
    expect(await pending).toMatchObject({ success: true,
      structuredResult: { status: "ok", image_url: "data:image/jpeg;base64,/9j/2Q==", detail: "original", observation } });
    const clicked = next(connected.socket);
    const click = cua.handler({ workdir: "/wayland-computer", action: "click", x: 0.5, y: 0.5 },
      { ...context, callId: "screen-click" });
    const clickRequest = await clicked;
    expect(clickRequest).toMatchObject({ type: "agent_call", surface_id: "desktop",
      generation: connected.state.generation, input: { action: "click", x: 0.5, y: 0.5 } });
    connected.socket.send(JSON.stringify({ type: "agent_result", request_id: clickRequest.request_id,
      status: "ok", jpeg: "/9j/2Q==", width: 1, height: 1 }));
    expect(await click).toMatchObject({ success: true, structuredResult: { status: "ok" } });
    allowed = false;
    expect(provider.screenTool(machine.id)).toBeUndefined();
    expect(await cua.handler({ workdir: "/wayland-computer", action: "click", x: 0.5, y: 0.5 }, context))
      .toMatchObject({ success: false, structuredResult: { status: "unavailable" } });
    allowed = true;
    const replacement = await host(machine.id);
    await provider.refresh();
    expect(await cua.handler({ workdir: "/wayland-computer", action: "click", x: 0.5, y: 0.5 }, context))
      .toMatchObject({ success: false, structuredResult: { status: "unavailable" } });
    const freshContext = { ...context, parentCallId: "replacement-cell", callId: "replacement-discover" };
    expect(await cua.handler({ workdir: "/wayland-computer" }, freshContext)).toHaveProperty("definitions");
    const released = next(replacement.socket);
    const release = reset.handler({ workdir: "/wayland-computer" }, { ...freshContext, callId: "replacement-release" });
    const releaseRequest = await released;
    replacement.socket.send(JSON.stringify({ type: "agent_result", request_id: releaseRequest.request_id, status: "ok" }));
    expect(await release).toMatchObject({ success: true });
    viewer.close(); connected.socket.close(); replacement.socket.close();
  });
  it("records through discovered CUA with bounded native results and authenticated host fences", async () => {
    const connected = await host("recording-hand", { schemaVersion: 1, available: true, operations: ["sources", "start", "pause", "resume", "stop", "status", "list", "read", "frame", "export", "delete"] }, false), otherHost = await host("recording-other", { schemaVersion: 1, available: false, reason: "store_unavailable" });
    const provider = new AccountHostedToolsProvider(namespace(), owner, () => true);
    await provider.refresh();
    const runtime = createNamespaceExecutionRuntime(() => provider.screenMachines(), () => undefined, undefined,
      (id, context) => provider.screenTool(id, context));
    const cua = runtime.tools[CUA_JS_NAME]!;
    const context = { sessionId: "recording-session", callId: "recording-call", parentCallId: "recording-cell", model: "fixture", signal: new AbortController().signal };
    const discovered: any = await cua.handler({ workdir: "/recording-hand" }, context);
    expect(discovered.definitions[0].parameters.properties.action.enum).toContain("recording");
    expect(discovered.definitions[0].parameters.properties.length.maximum).toBe(375_000);
    const unsupported: any = await cua.handler({ workdir: "/recording-other" }, context);
    expect(unsupported.definitions[0].parameters.properties.action.enum).not.toContain("recording");
    expect(await cua.handler({ workdir: "/recording-other", action: "recording", operation: "start", scope: { apps: ["pid:1"] } }, context))
      .toMatchObject({ success: false, structuredResult: { status: "unavailable" } });
    const id = "rec_" + "0".repeat(32), sha256 = "a".repeat(64);
    const sources = [{ app_id: "pid:1", window_id: "x11:2", process_id: 1 }];
    for (const input of [
      { action: "recording", operation: "sources" },
      { action: "recording", operation: "start", scope: { apps: ["pid:1"], capture_frames: false }, limits: { max_duration_ms: 2000, max_events: 1, max_bytes: 4096 } },
      { action: "recording", operation: "status", id },
      { action: "recording", operation: "pause", id },
      { action: "recording", operation: "resume", id },
      { action: "recording", operation: "stop", id },
      { action: "recording", operation: "list", cursor: 0, limit: 50 },
      { action: "recording", operation: "read", id, cursor: 0, limit: 200 },
      { action: "recording", operation: "export", id, cursor: 0, limit: 200 },
      { action: "recording", operation: "frame", id, sha256, offset: 0, length: 375_000 },
      { action: "recording", operation: "delete", id },
    ]) {
      const requested = next(connected.socket);
      const pending = cua.handler({ workdir: "/recording-hand", ...input }, { ...context, callId: "recording-" + input.operation });
      const request = await requested;
      expect(request).toMatchObject({ type: "agent_call", surface_id: "desktop", generation: connected.state.generation, input });
      expect(request.deadline_at).toBeGreaterThan(Date.now());
      const recording = input.operation === "sources" ? { status: "ok", sources } : input.operation === "pause" ? { status: "error", error: "conflict" } : input.operation === "frame"
        ? { status: "ok", id, sha256, bytes: 400_000, offset: 0, length: 375_000, next_cursor: 375_000, data_base64: "A".repeat(500_000) }
        : { status: "ok", id, state: "stopped", next_cursor: null };
      // A different authenticated Hand cannot settle this request.
      otherHost.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: "busy" }));
      connected.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: input.operation === "pause" ? "busy" : "ok", recording }));
      const result: any = await pending;
      expect(result).toMatchObject({ success: input.operation !== "pause", structuredResult: { status: input.operation === "pause" ? "busy" : "ok", recording } });
      console.log("RECORDING_EVIDENCE " + JSON.stringify({ transport: "CUA-AccountHostedTools-WebSocket", input: request.input,
        status: result.structuredResult.status, native_status: recording.status, response_bytes: new TextEncoder().encode(JSON.stringify(recording)).length }));
    }
    // A primary CUA provider must not hide the Hand-owned recording route.
    const primary = { definition: { description: "Attached CUA fixture", parameters: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
      handler: () => { throw new Error("Recording must not reach the interactive CUA provider"); } };
    const dualRuntime = createNamespaceExecutionRuntime(() => provider.screenMachines(),
      (_id, name) => name === CUA_JS_NAME || name === CUA_RESET_NAME ? primary : undefined,
      undefined, (id, context) => provider.screenTool(id, context));
    const dualCua = dualRuntime.tools[CUA_JS_NAME]!;
    const dualDiscovery: any = await dualCua.handler({ workdir: "/recording-hand" }, context);
    expect(dualDiscovery.definitions[0].parameters.anyOf[1].properties.action.enum).toEqual(["recording"]);
    expect(dualDiscovery.definitions[0].parameters.anyOf[1].properties.operation.enum).toContain("sources");
    const dualRequested = next(connected.socket);
    const dualPending = dualCua.handler({ workdir: "/recording-hand", action: "recording", operation: "sources" }, context);
    const dualRequest = await dualRequested;
    expect(dualRequest.input).toEqual({ action: "recording", operation: "sources" });
    connected.socket.send(JSON.stringify({ type: "agent_result", request_id: dualRequest.request_id, status: "ok", recording: { status: "ok", sources } }));
    expect(await dualPending).toMatchObject({ success: true, structuredResult: { recording: { sources } } });
    for (const input of [
      { action: "recording", operation: "sources", id },
      { action: "recording", operation: "start", context: { app: "App", window: "Window" } },
      { action: "recording", operation: "start", scope: { apps: ["pid:1"] }, limits: { max_events: 1 } },
      { action: "recording", operation: "start", scope: { apps: [] } },
      { action: "recording", operation: "start", scope: { windows: ["Window title"] } },
      { action: "recording", operation: "start", scope: { apps: ["pid:1"], capture_frames: "true" } },
      { action: "recording", operation: "delete", id: "../escape" },
      { action: "recording", operation: "list", limit: 51 },
      { action: "recording", operation: "frame", id, sha256, length: 375_001 },
      { action: "recording", operation: "frame", id, sha256, offset: -1 },
      { action: "recording", operation: "export", id, path: "/private" },
    ]) expect(await cua.handler({ workdir: "/recording-hand", ...input }, context))
      .toMatchObject({ success: false, structuredResult: { status: "invalid" } });
    const unauthorized = await connected.stub.fetch("https://account-tools.internal/invoke", { method: "POST", body: JSON.stringify({
      owner_id: other, name: connected.tool.definition.name, route_token: connected.tool.route_token,
      session_id: "11111111-1111-4111-8111-111111111199", call_id: "recording-unauthorized", input: { action: "recording", operation: "status", id },
    }) });
    expect(unauthorized.status).toBe(404);
    const abort = new AbortController(), cancelling = next(connected.socket);
    const cancelled = Promise.resolve(cua.handler({ workdir: "/recording-hand", action: "recording", operation: "export", id },
      { ...context, signal: abort.signal, callId: "recording-cancel" })).then(() => ({ name: "unexpected_success" }), (error: Error) => error);
    const admitted = await cancelling;
    const cancellation = next(connected.socket);
    abort.abort();
    expect(await cancellation).toEqual({ type: "agent_cancel", request_id: admitted.request_id });
    expect((await cancelled).name).toBe("AbortError");
    // Oversized native results close the offending host and settle its request as unknown.
    const requested = next(connected.socket);
    const pending = cua.handler({ workdir: "/recording-hand", action: "recording", operation: "status", id }, context);
    const request = await requested;
    connected.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: "ok", recording: { status: "ok", data_base64: "A".repeat(740_000) } }));
    expect(await pending).toMatchObject({ success: false, structuredResult: { status: "unavailable" } });
    console.log("RECORDING_EVIDENCE " + JSON.stringify({ transport: "CUA-AccountHostedTools-WebSocket", native_capability_discovered: true,
      primary_cua_recording_routed: true, wrong_owner: unauthorized.status, other_host_result_ignored: true,
      cancelled_request_id: admitted.request_id, malformed_requests: "invalid", oversized_response: "unavailable" }));
    otherHost.socket.close(); connected.socket.close();
  });
  it("rejects mixed, unbounded, and malformed input before sending anything", () => {
    for (const value of [ { action: "click", x: 0.2, y: 0.4, text: "mixed" }, { action: "drag", x: 0, y: 0, endX: 1, endY: 1, durationMs: 5000 },
      { action: "type", text: "🦄".repeat(1025) }, { action: "key", key: 40, modifiers: [224, 224] }, { action: "scroll", x: NaN, y: 0, deltaX: 0, deltaY: 2 } ]) {
      expect(() => screenAction(value)).toThrow();
    }
    expect(screenAction({ action: "click", x: 0.2, y: 0.4 })).toEqual({ action: "click", x: 0.2, y: 0.4 });
  });
  it("accepts bounded observe context selectors without expanding input actions", () => {
    const context = { app: "Example App", window: "Window" };
    expect(screenAction({ action: "observe", context })).toEqual({ action: "observe", context });
    for (const value of [{ action: "click", x: 0, y: 0, context }, { action: "release", context },
      { action: "observe", context: { app: "App" } }, { action: "observe", context: { ...context, app: "" } },
      { action: "observe", context: { ...context, window: "a\nb" } }, { action: "observe", context: { ...context, extra: true } },
      { action: "observe", context: { ...context, app: "🦄".repeat(129) } }]) expect(() => screenAction(value)).toThrow();
  });
  it("advertises an immutable account tool, returns images, and fences the result to its host", async () => {
    const first = await host("agent-primary"), second = await host("agent-other");
    const invoke = (entry: any, ownerID = owner) => first.stub.fetch("https://account-tools.internal/invoke", {
      method: "POST", body: JSON.stringify({ owner_id: ownerID, name: entry.definition.name, route_token: entry.route_token,
        session_id: "11111111-1111-4111-8111-111111111199", call_id: "screen-observe", input: { action: "observe" } }),
    });
    expect((await invoke(first.tool, other)).status).toBe(404);
    const requested = next(first.socket), pending = invoke(first.tool);
    const request = await requested;
    expect(request).toMatchObject({ type: "agent_call", surface_id: "desktop", generation: first.state.generation, input: { action: "observe" } });
    // Another published device cannot settle this device's admitted call.
    second.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: "busy" }));
    first.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: "ok", jpeg: "/9j/2Q==", width: 1, height: 1 }));
    const result: any = await (await pending).json();
    expect(result.success).toBe(true);
    expect(result.output[1]).toMatchObject({ type: "input_image", image_url: "data:image/jpeg;base64,/9j/2Q==" });
    expect(result.value).toMatchObject({ status: "ok", image_url: "data:image/jpeg;base64,/9j/2Q==", detail: "original" });
    expect(result.structured_result).toEqual(result.value);
    const replacement = await host("agent-primary");
    expect((await invoke(first.tool)).status).toBe(409);
    replacement.socket.close(); second.socket.close();
  });
  it("forwards provider context through the host boundary into text and both structured outputs", async () => {
    const connected = await host("agent-observation");
    const requested = next(connected.socket);
    const pending = connected.stub.fetch("https://account-tools.internal/invoke", { method: "POST", body: JSON.stringify({
      owner_id: owner, name: connected.tool.definition.name, route_token: connected.tool.route_token,
      session_id: "11111111-1111-4111-8111-111111111199", call_id: "screen-context", input: { action: "observe", context: { app: "Example", window: "Window" } },
    }) });
    const request = await requested;
    expect(request.input.context).toEqual({ app: "Example", window: "Window" });
    connected.socket.send(JSON.stringify({ type: "agent_result", request_id: request.request_id, status: "ok", jpeg: "/9j/2Q==", width: 1, height: 1, observation }));
    const result: any = await (await pending).json();
    expect(result.success).toBe(true);
    expect(result.value.observation).toEqual(observation);
    expect(result.structured_result).toEqual(result.value);
    expect(result.output.filter((item: any) => item.type === "input_image")).toHaveLength(1);
    expect(result.output.find((item: any) => item.text?.includes("Visible app state"))?.text).toContain("untrusted observed data");
    connected.socket.close();
  });
  it("keeps mobile screenshot-only and failure results compatible", () => {
    const result = screenResult({ status: "ok", jpeg: "/9j/2Q==", width: 1, height: 1 }, target);
    expect(result.value).not.toHaveProperty("observation");
    expect(result.output.map(item => item.type)).toEqual(["input_text", "input_image"]);
    expect(screenResult({ status: "ok", jpeg: "/9j/2Q==", observation: { ...observation, schemaVersion: 2 } as any }, target).value).not.toHaveProperty("observation");
    expect(screenResult({ status: "busy", observation }, target).value).not.toHaveProperty("observation");
  });
  it("reports unknown outcomes when the host disconnects without replaying input", async () => {
    const connected = await host("agent-disconnect");
    const requested = next(connected.socket);
    const response = connected.stub.fetch("https://account-tools.internal/invoke", { method: "POST", body: JSON.stringify({
      owner_id: owner, name: connected.tool.definition.name, route_token: connected.tool.route_token,
      session_id: "11111111-1111-4111-8111-111111111199", call_id: "screen-click", input: { action: "click", x: 0.5, y: 0.5 },
    }) });
    await requested; connected.socket.close();
    expect(await (await response).json()).toMatchObject({ success: false, structured_result: { status: "unavailable" } });
  });
});
