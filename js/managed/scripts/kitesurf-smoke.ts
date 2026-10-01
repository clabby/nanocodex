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
      const providerName = runtime.provider === "chromium" ? "Chromium" : "Kitesurf";
      const privateToolsSuppressed = runtime.tools.length === 1 && runtime.tools[0]?.name === "browser_execute";
      if (!privateToolsSuppressed) throw new Error(`${providerName} exposed unexpected private tools`);
      let secureInputBlocked = false;
      try { await runtime.submitSecureInput({}, new AbortController().signal); }
      catch (error) {
        secureInputBlocked = error instanceof Error && error.message.includes(`${providerName} does not support private browser continuation`);
      }
      if (!secureInputBlocked || loginLookups !== 0) throw new Error(`${providerName} secure input guard failed`);
      const tool = runtime.tools[0]!;
      const context = { callId: `${runtime.provider}-public-smoke`, signal: AbortSignal.timeout(90_000) } as ToolContext;
      const result = await tool.handler({ code: `
        const schema = await codemode.describe("cdp");
        if (!schema) throw new Error("CDP discovery returned no schema");
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
        return { schemaDiscovered: Boolean(schema), title: targets.targetInfos.find(target => target.targetId === created.targetId)?.title,
          containsExampleDomain: html.includes("Example Domain"), htmlLength: html.length };
      ` }, context);
      const execution = result as { status?: string; result?: { schemaDiscovered?: boolean; title?: string; containsExampleDomain?: boolean; htmlLength?: number } };
      if (execution.status !== "completed" || execution.result?.schemaDiscovered !== true || execution.result?.title !== "Example Domain"
        || execution.result.containsExampleDomain !== true || !(Number(execution.result.htmlLength) > 0)) throw new Error(`${providerName} smoke assertion failed`);
      let iframe: { crossOrigin: boolean; arithmetic: number } | undefined;
      if (runtime.provider === "chromium") {
        const frameResult = await tool.handler({ code: `
          const created = await cdp.send({ method: "Target.createTarget", params: { url: "about:blank" } });
          const attached = await cdp.attachToTarget({ targetId: created.targetId });
          const sessionId = typeof attached === "string" ? attached : attached.sessionId;
          await cdp.send({ method: "Page.enable", sessionId });
          await cdp.send({ method: "Page.navigate", params: { url: "https://checkout.stripe.dev/checkout" }, sessionId });
          let child;
          for (let attempt = 0; attempt < 60; attempt++) {
            const targets = await cdp.send({ method: "Target.getTargets" });
            child = targets.targetInfos.find(target => target.type === "iframe"
              && target.url.startsWith("https://js.stripe.com/v3/embedded-checkout-inner"));
            if (child) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (!child) throw new Error("Stripe demo did not expose its cross-origin iframe");
          const childAttached = await cdp.attachToTarget({ targetId: child.targetId });
          const childSessionId = typeof childAttached === "string" ? childAttached : childAttached.sessionId;
          await cdp.send({ method: "Runtime.enable", sessionId: childSessionId });
          const arithmetic = await cdp.send({ method: "Runtime.evaluate",
            params: { expression: "1+1", returnByValue: true }, sessionId: childSessionId });
          const origin = await cdp.send({ method: "Runtime.evaluate",
            params: { expression: "location.origin", returnByValue: true }, sessionId: childSessionId });
          return { crossOrigin: origin.result?.value === "https://js.stripe.com", arithmetic: arithmetic.result?.value };
        ` }, { ...context, callId: "chromium-cross-origin-smoke", signal: AbortSignal.timeout(90_000) });
        const frameExecution = frameResult as { status?: string; result?: { crossOrigin?: boolean; arithmetic?: number } };
        if (frameExecution.status !== "completed" || frameExecution.result?.crossOrigin !== true
          || frameExecution.result.arithmetic !== 2) throw new Error("Chromium cross-origin iframe evaluation failed");
        iframe = { crossOrigin: true, arithmetic: 2 };
      }
      return Response.json({ provider: runtime.provider, status: "completed", schemaDiscovered: true, title: "Example Domain",
        containsExampleDomain: true, htmlLength: execution.result.htmlLength,
        ...(iframe ? { iframe } : {}), privateToolsSuppressed, secureInputBlocked, loginLookups });
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
