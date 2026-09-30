import { connectBrowser, deleteBrowserSession, type BrowserBinding, type CdpSession } from "agents/browser";
import type { ToolContext } from "nanocodex";
import type { BrowserVaultResolver } from "./browser-vault";

/** Fills a login and activates its sign-in control once, then reads fixed
 * checkout capabilities. It does not activate booking, payment, registration,
 * password-reset or consent controls. Merchant sign-in can have side effects.
 * The caller must obtain explicit authority to use the named saved Vault item.
 * The resolver must enforce the Vault item's exact approved HTTPS origin. */
export type PrivateCheckoutInput = Readonly<{
  vault_id: string;
  url: string;
  username_selector?: string;
  password_selector?: string;
}>;
export type PrivateCheckoutResult = Readonly<{
  status: "inspected" | "login_required" | "challenge" | "unavailable" | "outcome_unknown";
  reason?: "invalid_request" | "not_authorized" | "unsupported_login" | "private_inspection_failed" | "cleanup_unconfirmed";
  login_attempted: boolean;
  failure_stage?: "browser" | "document" | "vault" | "fill" | "submit" | "inspection";
  checkout?: Readonly<{
    checkout_detected: boolean;
    card_fields_present: boolean;
    stripe_frame_present: boolean;
    link_pay_token: "supported" | "not_detected" | "inspection_incomplete";
  }>;
}>;

export function parsePrivateCheckoutInput(value: unknown): PrivateCheckoutInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid private checkout request");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["vault_id", "url", "username_selector", "password_selector"].includes(k))
    || typeof v.vault_id !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(v.vault_id)
    || typeof v.url !== "string" || v.url.length > 4096) throw new Error("Invalid private checkout request");
  let url: URL;
  try { url = new URL(v.url); } catch { throw new Error("Invalid private checkout request"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid private checkout request");
  for (const selector of [v.username_selector, v.password_selector]) {
    if (selector !== undefined && (typeof selector !== "string" || !selector.trim() || selector.length > 256
      || /[\u0000-\u001f\u007f]/.test(selector))) throw new Error("Invalid private checkout request");
  }
  return { vault_id: v.vault_id, url: url.href,
    username_selector: v.username_selector as string | undefined,
    password_selector: v.password_selector as string | undefined };
}

// Host-owned program only. Secret arguments never enter Code Mode or results.
// Runs in an isolated world, so page overrides of JS builtins cannot forge it.
const LOGIN = `function(origin, usernameSelector, passwordSelector, mode, value) {
  if (location.origin !== origin || location.protocol !== 'https:' || window !== window.top) return null;
  const visible = (el, allowDisabled = false, requireViewport = false) => {
    if (!(el instanceof HTMLElement) || !el.isConnected || el.getRootNode() !== document
      || el.closest('[inert],[hidden],[aria-hidden="true"]') || (!allowDisabled && el.matches(':disabled'))
      || (!allowDisabled && el.getAttribute('aria-disabled') === 'true') || !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!requireViewport || (r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
      && el.contains(document.elementFromPoint(r.left+r.width/2, r.top+r.height/2))));
  };
  const inputs = selector => { const list = document.querySelectorAll(selector); return list.length === 1 ? list[0] : null; };
  const user = inputs(usernameSelector), pass = inputs(passwordSelector);
  if (!(user instanceof HTMLInputElement) || !(pass instanceof HTMLInputElement) || user === pass
    || !['email','text'].includes(user.type) || pass.type !== 'password' || user.readOnly || pass.readOnly
    || !visible(user) || !visible(pass)) return null;
  const form = user.form;
  if (form !== pass.form) return null;
  if (form) {
    const action = new URL(form.action, location.href);
    if (action.origin !== origin || action.username || action.password || (form.target && form.target !== '_self')) return null;
    // Explicit GET forms are unsupported. Method-less SPA forms work through
    // JavaScript handlers; native form navigation is disabled below.
    if (form.hasAttribute('method') && form.method.toLowerCase() !== 'post') return null;
  }
  const candidates = [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(el => {
    if (!visible(el, mode !== 'submit') || el.form !== form) return false;
    const label = (el instanceof HTMLInputElement ? el.value : el.innerText).trim().replace(/\\s+/g,' ').toLowerCase();
    if (!/^(sign in|log in|login)$/.test(label)) return false;
    if (el.formTarget && el.formTarget !== '_self') return false;
    if (el.hasAttribute('formaction') && new URL(el.formAction, location.href).origin !== origin) return false;
    if (el.hasAttribute('formmethod') && el.formMethod.toLowerCase() !== 'post') return false;
    return true;
  });
  if (candidates.length !== 1) return null;
  const button = candidates[0];
  const old = globalThis.__privateCheckoutLogin;
  if (mode === 'capture') {
    if (!document.head) return null;
    // Browser-enforced CSP covers default submission AND direct form.submit(),
    // which bypasses submit listeners. Removing this meta cannot relax CSP.
    // JavaScript fetch/XHR sign-in still works; native POST/GET navigation does not.
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "form-action 'none'";
    document.head.append(policy);
    globalThis.__privateCheckoutLogin = {user,pass,button,form}; return true;
  }
  if (!old || old.user !== user || old.pass !== pass || old.button !== button || old.form !== form) return null;
  if (mode === 'username' || mode === 'password') {
    const el = mode === 'username' ? user : pass;
    if (el.value !== '' || typeof value !== 'string') return null;
    // Keep the write bound to this captured document and element. A native
    // Input.insertText command could race navigation/focus between CDP calls.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    Reflect.apply(set,el,[value]);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  }
  if (mode === 'scroll_submit') { button.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true; }
  if (mode === 'submit') {
    if (!user.value || !pass.value || !visible(button,false,true)) return null;
    // The captured DOM control is invoked in this isolated execution context;
    // navigation destroys it instead of retargeting a coordinate click.
    Reflect.apply(HTMLElement.prototype.click,button,[]);
    return true;
  }
  return null;
}`;

const INSPECT = `function(origin, stripe) {
  if (location.origin !== origin || location.protocol !== 'https:') return null;
  const visible = el => el instanceof HTMLElement && el.isConnected && !el.closest('[hidden],[inert],[aria-hidden="true"]')
    && el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const text = (document.body?.innerText || '').slice(0, 65536);
  const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const challenge = [...document.querySelectorAll('input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[title*="challenge" i]')].some(visible);
  const checkout = /\\b(checkout|order summary|payment details|payment method)\\b/i.test(text);
  const card = [...document.querySelectorAll('input[autocomplete="cc-number"],input[name="cardnumber"],input[name="number"]')].some(visible);
  // A merchant opt-in marker inside a genuine Stripe document is required.
  // Do not read its value or expose the merchant account; never click consent.
  const marker = stripe && [...document.querySelectorAll('input[name="link_pay_token"][data-stripe-merchant-account]')]
    .some(el => (el.getAttribute('data-stripe-merchant-account') || '').trim().length > 0);
  return {password,challenge,checkout,card,marker};
}`;

type Frame = { id: string; loaderId: string; url: string; securityOrigin?: string; parentId?: string };
type FrameTree = { frame: Frame; childFrames?: FrameTree[] };
type World = { session: string; frame: Frame; contextId: number };
type Flags = { password: boolean; challenge: boolean; checkout: boolean; card: boolean; marker: boolean };
const stripeOrigin = (url: string) => {
  try { const u = new URL(url); return u.protocol === "https:" && ["js.stripe.com", "hooks.stripe.com"].includes(u.hostname) && u.port === "" ? u.origin : null; }
  catch { return null; }
};

/** Fresh upstream Chromium connection, inaccessible to Code Mode. No socket,
 * session, execution context, page string, exception, or debug log is returned.
 * agents 0.22 CdpSession's ring contains metadata only, never params/results.
 * Use disconnect + awaited delete instead of close's fire-and-forget disposer,
 * which can log a provider error. Recording is explicitly disabled. */
export type PrivateCheckoutOptions = Readonly<{
  browser: BrowserBinding;
  input: unknown;
  context: ToolContext;
  resolveVaultLogin: BrowserVaultResolver;
  authorizeVaultAccess: (context: ToolContext) => void;
}>;

export async function inspectPrivateCheckout(options: PrivateCheckoutOptions): Promise<PrivateCheckoutResult> {
  return runPrivateCheckout(options);
}

/** Internal host-only extension point. Programs and callbacks are never tool input. */
export async function runPrivateCheckout<T = never>(options: Readonly<{
  browser: BrowserBinding;
  input: unknown;
  context: ToolContext;
  resolveVaultLogin: BrowserVaultResolver;
  authorizeVaultAccess: (context: ToolContext) => void;
  afterLogin?: (evaluate: (program: string, args: unknown[]) => Promise<unknown>) => Promise<T>;
}>): Promise<PrivateCheckoutResult | T> {
  let input: PrivateCheckoutInput;
  try { input = parsePrivateCheckoutInput(options.input); }
  catch { return { status: "unavailable", reason: "invalid_request", login_attempted: false }; }
  try { options.authorizeVaultAccess(options.context); }
  catch { return { status: "unavailable", reason: "not_authorized", login_attempted: false }; }
  let cdp: CdpSession | undefined;
  let attempted = false;
  let stage: NonNullable<PrivateCheckoutResult["failure_stage"]> = "browser";
  let credentials: Awaited<ReturnType<BrowserVaultResolver>> | undefined;
  let result: PrivateCheckoutResult | T = { status: "unavailable", reason: "private_inspection_failed", login_attempted: false };
  const origin = new URL(input.url).origin;
  const signal = options.context.signal;
  const deadline = Date.now() + 60_000;
  // Only this private operation bounds provider I/O. The public runtime still
  // receives env.BROWSER directly and uses the upstream tools unchanged.
  const privateBrowser: BrowserBinding = { fetch: (input, init) => {
    const cleanup = init?.method === "DELETE";
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const socket = headers.get("upgrade")?.toLowerCase() === "websocket";
    // An abort signal stays attached to an upgraded socket after fetch returns.
    // Bound the socket by the operation, not the ordinary HTTP request timeout.
    const ioSignal = AbortSignal.any([AbortSignal.timeout(socket ? 60_000 : 8000), ...(!cleanup ? [signal] : [])]);
    return options.browser.fetch(input, {...init, signal:ioSignal});
  } };
  const check = () => { if (signal.aborted || Date.now() >= deadline) throw new Error("Private inspection stopped"); };
  const send = async (method: string, params: unknown = {}, sessionId?: string): Promise<any> => {
    check();
    try { return await cdp!.send(method, params, { sessionId, timeoutMs: Math.min(8000, Math.max(1, deadline-Date.now())) }); }
    finally { cdp?.clearDebugLog(); }
  };
  const frameTree = async (session: string): Promise<FrameTree> => (await send("Page.getFrameTree", {}, session)).frameTree;
  const validFrame = (frame: Frame, expectedOrigin: string) => {
    if (!frame || typeof frame.id !== "string" || !frame.id || typeof frame.loaderId !== "string" || !frame.loaderId
      || new URL(frame.url).origin !== expectedOrigin || (frame.securityOrigin !== undefined && frame.securityOrigin !== expectedOrigin)) throw new Error("Document changed");
  };
  const findFrame = (tree: FrameTree, id: string): Frame | undefined => tree.frame.id === id ? tree.frame : tree.childFrames?.map(t => findFrame(t,id)).find(Boolean);
  const verify = async (world: World, expectedOrigin: string) => {
    const frame = findFrame(await frameTree(world.session), world.frame.id);
    if (!frame || frame.loaderId !== world.frame.loaderId) throw new Error("Document changed");
    validFrame(frame, expectedOrigin);
  };
  const world = async (session: string, frame: Frame, expectedOrigin: string): Promise<World> => {
    validFrame(frame, expectedOrigin);
    const made = await send("Page.createIsolatedWorld", {frameId:frame.id,worldName:"private-checkout",grantUniveralAccess:false}, session);
    if (!Number.isInteger(made.executionContextId)) throw new Error("Private document unavailable");
    const w = {session,frame,contextId:made.executionContextId}; await verify(w,expectedOrigin); return w;
  };
  const evaluate = async (w: World, expectedOrigin: string, program: string, args: unknown[]) => {
    await verify(w,expectedOrigin);
    const value = await send("Runtime.callFunctionOn", {executionContextId:w.contextId,functionDeclaration:program,
      arguments:args.map(value => ({value})),returnByValue:true,silent:true},w.session);
    if (value.exceptionDetails) throw new Error("Private inspection unavailable");
    await verify(w,expectedOrigin); return value.result?.value;
  };
  const abort = () => { cdp?.disconnect(); cdp?.clearDebugLog(); };
  signal.addEventListener("abort", abort, {once:true});
  const timer = setTimeout(abort,60_000);
  try {
    check();
    cdp = await connectBrowser(privateBrowser, {timeoutMs:8000,recording:false});
    check();
    const context = await send("Target.createBrowserContext", {disposeOnDetach:true});
    const target = await send("Target.createTarget", {url:"about:blank",browserContextId:context.browserContextId});
    const session = await cdp.attachToTarget(target.targetId, {timeoutMs:8000});
    stage="document";
    await send("Page.enable", {}, session);
    await send("Page.navigate", {url:input.url}, session);
    let loginWorld: World | undefined;
    const selectors = [input.username_selector ?? 'input[type="email"]',input.password_selector ?? 'input[type="password"]'];
    // Readiness polls are read-only. No credential submission is ever retried.
    for (let poll=0;poll<30;poll++) {
      const tree = await frameTree(session);
      if (tree.frame.url !== "about:blank") {
        validFrame(tree.frame,origin);
        const w = await world(session,tree.frame,origin);
        if (await evaluate(w,origin,LOGIN,[origin,...selectors,"capture"]) === true) { loginWorld=w; break; }
      }
      await new Promise(resolve => setTimeout(resolve,250));
    }
    if (!loginWorld) { result={status:"unavailable",reason:"unsupported_login",login_attempted:false}; }
    else {
      stage="vault";
      // Trusted internal RPC verifies that origin is approved for this saved ID.
      credentials = await options.resolveVaultLogin({vault_id:input.vault_id,expected_origin:origin,target_id:target.targetId,
        username_selector:selectors[0],password_selector:selectors[1],submit:true}, options.context);
      check();
      if (!credentials || typeof credentials.username !== "string" || typeof credentials.password !== "string"
        || !credentials.username || !credentials.password || credentials.username.length>4096 || credentials.password.length>4096
        || /[\u0000-\u001f\u007f]/.test(credentials.username+credentials.password)) throw new Error("Private credential unavailable");
      // Filling can trigger a site's own automatic sign-in behavior. From here
      // onward an interruption is uncertain and must never be retried here.
      stage="fill";
      attempted=true;
      for (const [index,mode] of ["username","password"].entries()) {
        if (await evaluate(loginWorld,origin,LOGIN,[origin,...selectors,mode,index===0 ? credentials.username : credentials.password]) !== true) throw new Error("Login changed");
      }
      stage="submit";
      if (await evaluate(loginWorld,origin,LOGIN,[origin,...selectors,"scroll_submit"]) !== true) throw new Error("Login changed");
      if (await evaluate(loginWorld,origin,LOGIN,[origin,...selectors,"submit"]) !== true) throw new Error("Login changed");
      stage="inspection";
      let flags: Flags | undefined;
      let tree: FrameTree | undefined;
      for (let poll=0;poll<24;poll++) {
        await new Promise(resolve=>setTimeout(resolve,250));
        tree = await frameTree(session);
        validFrame(tree.frame,origin);
        try {
          const w = await world(session,tree.frame,origin);
          flags = await evaluate(w,origin,INSPECT,[origin,false]);
        } catch {
          // A JavaScript sign-in may navigate while this read-only observation
          // is in flight. Reacquire and validate its document on the next poll;
          // never repeat credential entry or sign-in submission.
          check(); flags=undefined; continue;
        }
        if (!flags || Object.values(flags).some(v=>typeof v!=="boolean")) throw new Error("Private inspection unavailable");
        if (flags.challenge || (!flags.password && (flags.checkout || options.afterLogin))) break;
      }
      if (!flags || !tree) throw new Error("Private inspection unavailable");
      if (options.afterLogin && !flags.password && !flags.challenge) {
        const authenticatedWorld = await world(session, tree.frame, origin);
        result = await options.afterLogin((program, args) => evaluate(authenticatedWorld, origin, program, args));
      } else {
        let stripe=false, marker=false, incomplete=false, card=flags.card;
        const scan = async (t: FrameTree, sid: string, depth=0): Promise<void> => {
          if (depth>5) { incomplete=true; return; }
          const frameOrigin = stripeOrigin(t.frame.url);
          if (frameOrigin) {
            stripe=true;
            try {
              const w = await world(sid,t.frame,frameOrigin);
              const f = await evaluate(w,frameOrigin,INSPECT,[frameOrigin,true]);
              marker ||= f?.marker === true; card ||= f?.card === true;
            } catch { incomplete=true; }
          }
          if ((t.childFrames?.length ?? 0)>20) incomplete=true;
          for (const child of (t.childFrames ?? []).slice(0,20)) await scan(child,sid,depth+1);
        };
        await scan(tree,session);
        // OOPIF Stripe documents may be absent from the parent Page frame tree.
        const targets = await send("Target.getTargets");
        for (const t of (targets.targetInfos ?? []).slice(0,100)) {
          if (t.type !== "iframe" || t.browserContextId !== context.browserContextId || !stripeOrigin(t.url)) continue;
          stripe=true;
          try { const sid=await cdp.attachToTarget(t.targetId,{timeoutMs:8000}); await scan(await frameTree(sid),sid); }
          catch { incomplete=true; }
        }
        result = {status:flags.challenge ? "challenge" : flags.password ? "login_required" : "inspected",login_attempted:true,
          checkout:{checkout_detected:flags.checkout,card_fields_present:card,stripe_frame_present:stripe,
            link_pay_token:marker ? "supported" : incomplete ? "inspection_incomplete" : "not_detected"}};
      }
    }
  } catch {
    result={status:attempted ? "outcome_unknown" : "unavailable",reason:"private_inspection_failed",login_attempted:attempted,failure_stage:stage};
  } finally {
    credentials=undefined;
    clearTimeout(timer);
    signal.removeEventListener("abort",abort);
    if (cdp) {
      cdp.disconnect(); cdp.clearDebugLog();
      try {
        if (!cdp.sessionId) throw new Error("Private cleanup unavailable");
        await deleteBrowserSession(privateBrowser,cdp.sessionId);
      } catch {
        result={status:attempted ? "outcome_unknown" : "unavailable",reason:"cleanup_unconfirmed",login_attempted:attempted};
      }
    }
  }
  return result;
}
