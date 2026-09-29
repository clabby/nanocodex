import { DurableObject } from "cloudflare:workers";
import { createManagedBrowserRuntime, type ManagedBrowserEnv } from "../src/browser-runtime";
import type { ToolContext } from "nanocodex";
interface Env extends ManagedBrowserEnv { SMOKE: DurableObjectNamespace<KitesurfSmoke> }
export class KitesurfSmoke extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    let loginLookups = 0;
    const runtime = await createManagedBrowserRuntime({
      ctx: this.ctx, env: this.env, sessionId: "public-smoke",
      authorizeVaultAccess: () => {},
      resolveVaultLogin: async () => { loginLookups++; throw new Error("Unexpected login lookup"); },
    });
    try {
      const privateToolsSuppressed = runtime.tools.length === 1 && runtime.tools[0]?.name === "browser_execute";
      if (!privateToolsSuppressed) throw new Error("Kitesurf exposed unexpected private tools");
      let secureInputBlocked = false;
      try { await runtime.submitSecureInput({}, new AbortController().signal); }
      catch (error) {
        secureInputBlocked = error instanceof Error && error.message.includes("Kitesurf does not support private browser continuation");
      }
      if (!secureInputBlocked || loginLookups !== 0) throw new Error("Kitesurf secure input guard failed");
      const tool = runtime.tools[0]!;
      const context = { callId: "kitesurf-public-smoke", signal: AbortSignal.timeout(90_000) } as ToolContext;
      const result = await tool.handler({ code: `
        const created = await cdp.send({ method: "Target.createTarget", params: { url: "https://example.com" } });
        const attached = await cdp.attachToTarget({ targetId: created.targetId });
        const sessionId = typeof attached === "string" ? attached : attached.sessionId;
        await cdp.send({ method: "Page.enable", sessionId });
        await cdp.send({ method: "Page.navigate", params: { url: "https://example.com" }, sessionId });
        let html = "";
        for (let attempt = 0; attempt < 30; attempt++) {
          const document = await cdp.send({ method: "DOM.getDocument", sessionId });
          const output = await cdp.send({ method: "DOM.getOuterHTML", params: { nodeId: document.root.nodeId }, sessionId });
          html = output.outerHTML;
          if (html.includes("Example Domain")) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        const targets = await cdp.send({ method: "Target.getTargets" });
        return { title: targets.targetInfos.find(target => target.targetId === created.targetId)?.title,
          containsExampleDomain: html.includes("Example Domain"), htmlLength: html.length };
      ` }, context);
      let credentialPolicyBlocked = false;
      try { await tool.handler({ code: 'await cdp.send({ method: "Runtime.evaluate", params: { expression: "1+1" } })' }, context); }
      catch { credentialPolicyBlocked = true; }
      const execution = result as { status?: string; result?: { title?: string; containsExampleDomain?: boolean; htmlLength?: number } };
      if (execution.status !== "completed" || execution.result?.title !== "Example Domain"
        || execution.result.containsExampleDomain !== true || !(Number(execution.result.htmlLength) > 0)
        || !credentialPolicyBlocked) throw new Error("Kitesurf smoke assertion failed");
      return Response.json({ provider: "kitesurf", status: "completed", title: "Example Domain",
        containsExampleDomain: true, htmlLength: execution.result.htmlLength, credentialPolicyBlocked: true,
        privateToolsSuppressed, secureInputBlocked, loginLookups });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Smoke failed";
      return Response.json({ error: message.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, "[URL redacted]") }, { status: 500 });
    } finally { await runtime.close(); }
  }
}
export default { fetch(request: Request, env: Env) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/smoke") {
    return new Response("Use POST /smoke", { status: 404 });
  }
  return env.SMOKE.getByName("smoke").fetch("https://smoke.invalid");
} };

export { CodemodeRuntime } from "@cloudflare/codemode";
