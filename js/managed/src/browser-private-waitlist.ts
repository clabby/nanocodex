import { parsePrivateCheckoutInput, runPrivateCheckout, type PrivateCheckoutInput, type PrivateCheckoutOptions, type PrivateCheckoutResult } from "./browser-private-checkout";

export type PrivateWaitlistInput = PrivateCheckoutInput & Readonly<{
  operation: "inspect" | "join";
  operation_id: string;
  expected: Readonly<{ title: string; date: string; time: string; instructor: string }>;
  authorize_join?: boolean;
}>;
export type PrivateWaitlistResult = Readonly<{
  status: "inspected" | "ready" | "joined" | "already_waitlisted" | "class_mismatch" | "payment_required" | "policy_required" | "unsupported" | "login_required" | "challenge" | "unavailable" | "outcome_unknown" | "conflict";
  reason?: "invalid_request" | "not_authorized" | "operation_mismatch" | "operation_pending" | "private_operation_failed" | "cleanup_unconfirmed";
  failure_stage?: "login" | "inspect" | "inspect_result" | "capture" | "capture_result" | "join" | "join_result" | "confirmation" | "confirmation_result";
  login_failure_stage?: PrivateCheckoutResult["failure_stage"];
  login_attempted: boolean;
  join_attempted: boolean;
  confirmation_observed: boolean;
  cleanup_confirmed: boolean;
  action: "none" | "waitlist_only" | "payment" | "policy" | "unsupported";
  capabilities?: Readonly<{
    class_verified: boolean;
    join_control_present: boolean;
    join_control_enabled: boolean;
    payment_control_present: boolean;
    policy_required: boolean;
    existing_credits_present: boolean;
    no_payment_action: boolean;
    confirmation_present: boolean;
  }>;
}>;

export function parsePrivateWaitlistInput(value: unknown): PrivateWaitlistInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid waitlist request");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["vault_id", "url", "username_selector", "password_selector", "operation", "operation_id", "expected", "authorize_join"].includes(k))
    || !["inspect", "join"].includes(v.operation as string)
    || typeof v.operation_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.operation_id)
    || (v.authorize_join !== undefined && typeof v.authorize_join !== "boolean")
    || !v.expected || typeof v.expected !== "object" || Array.isArray(v.expected)) throw new Error("Invalid waitlist request");
  const expected = v.expected as Record<string, unknown>;
  const keys = ["title", "date", "time", "instructor"] as const;
  if (Object.keys(expected).length !== 4 || keys.some(k => typeof expected[k] !== "string" || !(expected[k] as string).trim()
    || (expected[k] as string).length > 160 || /[\u0000-\u001f\u007f]/.test(expected[k] as string))) throw new Error("Invalid waitlist request");
  const login = parsePrivateCheckoutInput({ vault_id: v.vault_id, url: v.url, username_selector: v.username_selector, password_selector: v.password_selector });
  return { ...login, operation: v.operation as "inspect" | "join", operation_id: v.operation_id.toLowerCase(),
    expected: Object.fromEntries(keys.map(k => [k, (expected[k] as string).trim()])) as PrivateWaitlistInput["expected"],
    authorize_join: v.authorize_join as boolean | undefined };
}

// Fixed host program. It reads visible DOM only; never application state,
// network responses, credentials, cookies, or arbitrary caller JavaScript.
// Arketa's pure Join the Waitlist control calls joinWaitlist(classId, guests),
// whereas Purchase & Join the waitlist invokes checkout. This distinction is
// specific to Arketa's checkout UI, not a generic missing-price heuristic.
const WAITLIST = String.raw`function(url, expected, mode) {
  if (window !== window.top || location.href !== url || location.protocol !== 'https:') return null;
  const visible = el => el instanceof HTMLElement && el.isConnected && el.getRootNode() === document
    && !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const norm = value => value.trim().replace(/\s+/g,' ').toLowerCase();
  const visibleText = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = []; let node, count = 0, size = 0;
    while ((node = walker.nextNode())) {
      if (++count > 10000) throw new Error('Unsupported document');
      if (!visible(node.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some(rect=>rect.width > 0 && rect.height > 0)) continue;
      const part = node.textContent || '';
      size += part.length;
      if (size > 100000) throw new Error('Unsupported document');
      if (part.trim()) parts.push(part);
    }
    return parts;
  };
  if (!document.body) return null;
  // Text-node visibility avoids ancestors laundering hidden descendants into
  // class identity or success proof (innerText alone includes opacity/ARIA).
  const text = visibleText(document.body).join('\n');
  const lines = text.split(/\n/).map(norm).filter(Boolean);
  const exact = value => lines.includes(norm(value));
  const identityIn = root => {
    const scopedLines = visibleText(root).join('\n').split(/\n/).map(norm).filter(Boolean);
    const equals = value => scopedLines.includes(norm(value));
    const includes = value => { const needle=norm(value); return scopedLines.some(line=>line === needle || line.startsWith(needle+' ') || line.endsWith(' '+needle) || line.includes(' '+needle+' ')); };
    return equals(expected.title) && includes(expected.date) && includes(expected.time)
      && (equals(expected.instructor) || equals('with '+expected.instructor) || equals('Instructor: '+expected.instructor));
  };
  const controls = [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(visible);
  const label = el => norm(el instanceof HTMLInputElement ? el.value : visibleText(el).join(' '));
  const joins = controls.filter(el => label(el) === 'join the waitlist');
  const payments = controls.filter(el => /^(purchase|pay|save and purchase|purchase & join the waitlist|purchase & add guests to the waitlist)(\b|$)/.test(label(el)));
  const enabled = el => !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
  const checkboxVisible = el => visible(el) || el instanceof HTMLInputElement && el.isConnected
    && !el.closest('[hidden],[inert],[aria-hidden="true"]') && [...(el.labels || [])].some(visible);
  const policy = [...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(checkboxVisible).some(el => {
    const checked = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
    const labels = el instanceof HTMLInputElement ? [...(el.labels || [])].map(x=>visibleText(x).join(' ')).join(' ') : visibleText(el).join(' ');
    return !checked && (el.matches('[required],[aria-required="true"],#liability-waiver-checkbox,#offering-terms-checkbox,#cancelation-checkbox')
      || /waiver|terms|cancellation policy/i.test(labels))
      || checked && el.matches('#marketing-switch,#sms-switch');
  });
  const recurring = [...document.querySelectorAll('input[type="checkbox"]')].filter(checkboxVisible).some(el => el.checked
    && (el.id === 'scheduleRecurringBooking' || [...(el.labels || [])].some(x=>/every week|recurring/i.test(visibleText(x).join(' ')))));
  const reserveFor = [...document.querySelectorAll('input[type="radio"][name="reserveFor"]')].filter(checkboxVisible);
  const selectedReserveFor = reserveFor.filter(el=>el.checked);
  const guests = reserveFor.length > 0 && (selectedReserveFor.length !== 1 || selectedReserveFor[0].id !== 'reserveForMyself')
    || /(?:reserve for|booking for)\s*\n\s*(?:someone else|family|guests)/i.test(text)
    || controls.some(el=>/^(remove guest|remove family member)$/.test(label(el)))
    || [...document.querySelectorAll('input')].filter(visible).some(el=> !['radio','checkbox','button','submit'].includes(el.type) && /guest/i.test(el.name+' '+el.id+' '+el.placeholder) && el.value);
  // Arketa uses a notice in checkout and a heading on its reservation card.
  // Preserve adjacent text-node punctuation (React splits You / ' / re).
  const successTexts = [
    'You have been added to the waitlist! If a spot opens up, you will receive an email.',
    "You're on the waitlist",
    "You've Been Added To The Waitlist!",
  ].map(norm);
  const success = el => successTexts.includes(norm(visibleText(el).join('')));
  const confirmations = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,span,[role="status"],[role="alert"]')].filter(visible)
    .filter(success)
    .filter(el=>![...el.children].some(child=>visible(child) && success(child)));
  // A completed reservation can retain an unrelated purchase form below it.
  // Associate the receipt with its own class region before inspecting controls.
  const anchor = confirmations.length === 1 ? confirmations[0] : joins.length === 1 ? joins[0] : payments.length === 1 ? payments[0] : null;
  let classScope = null;
  // Require a local semantic checkout region containing both identity and
  // action/receipt. The entire page/app root is not a class association.
  for (let el=anchor?.parentElement; el && el !== document.body; el=el.parentElement) {
    if (el.matches('main,[role="main"],section,article,form,[data-checkout],.checkout,.checkout-section,.checkout-container')
      && visible(el)) {
      if (identityIn(el)) { classScope=el; break; }
      // Arketa separates the class header from its action form inside one
      // checkout section. A bare action form is not a competing class region.
      if (el.matches('form') && ![...el.querySelectorAll('h1,h2,h3,h4,h5,h6,.classTitle')].some(visible)) continue;
      break;
    }
  }
  const classVerified = classScope !== null;
  const confirmation = classVerified && confirmations.length === 1 && classScope.contains(confirmations[0]);
  const credits = /\b(?:available credits|credits remaining|existing credits|use credits)\b/i.test(text);
  const creditSpend = /\b(?:use|redeem|deduct|consume)\s+(?:\d+\s+)?credits?\b/i.test(text);
  const duePositive = /(?:^|\n)\s*(?:total(?: due)?|amount due|pay today)\s*[:\n]?\s*(?:[A-Z]{3}\s*)?[$€£]?\s*([0-9]+(?:[.,][0-9]+)*)/ig;
  let amount, positive = false, amountKnown = false;
  while ((amount = duePositive.exec(text))) { amountKnown = true; if (Number(amount[1].replace(/[.,]/g,'')) > 0) positive = true; }
  const arketa = ['app.arketa.co','app.arketa.com','arketa.co','arketa.com'].includes(location.hostname) && /\/checkout(?:\/|$)/.test(location.pathname);
  const free = exact('Free waitlist') || exact('No payment required to join the waitlist') || amountKnown && !positive;
  const noPayment = (arketa || free) && joins.length === 1 && payments.length === 0 && !positive && !creditSpend;
  const capabilities = {class_verified:classVerified,join_control_present:joins.length === 1,
    join_control_enabled:joins.length === 1 && enabled(joins[0]),payment_control_present:payments.length > 0 || positive || creditSpend,
    policy_required:policy,existing_credits_present:credits,no_payment_action:noPayment,confirmation_present:confirmation};
  let status = !classVerified ? 'class_mismatch' : confirmation ? 'already_waitlisted' : policy ? 'policy_required'
    : payments.length || positive || creditSpend ? 'payment_required' : recurring || guests || !noPayment || !enabled(joins[0]) ? 'unsupported' : 'ready';
  const action = status === 'ready' ? 'waitlist_only' : status === 'payment_required' ? 'payment' : status === 'policy_required' ? 'policy' : status === 'unsupported' ? 'unsupported' : 'none';
  const output = {status,action,capabilities};
  if (mode === 'inspect' || mode === 'confirmation') return output;
  if (status !== 'ready') return output;
  const button = joins[0];
  if (button.formTarget && button.formTarget !== '_self') return null;
  if (button.hasAttribute('formaction')) {
    const action = new URL(button.formAction,location.href);
    if (action.origin !== location.origin || action.username || action.password) return null;
  }
  if (button.hasAttribute('formmethod') && button.formMethod.toLowerCase() !== 'post') return null;
  if (button.form) {
    const action = new URL(button.form.action,location.href);
    if (action.origin !== location.origin || action.username || action.password
      || button.form.target && button.form.target !== '_self'
      || button.form.hasAttribute('method') && button.form.method.toLowerCase() !== 'post') return null;
  }
  if (mode === 'capture') {
    if (!document.head) return null;
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "form-action 'none'";
    document.head.append(policy);
    button.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    globalThis.__privateWaitlist = {button, classScope, url, expected:JSON.stringify(expected)};
    return output;
  }
  if (mode !== 'join') return null;
  const old = globalThis.__privateWaitlist;
  if (!old || old.button !== button || old.classScope !== classScope || old.url !== url || old.expected !== JSON.stringify(expected)) return null;
  const r = button.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight
    || !button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))) return null;
  // Capture installs form-action 'none' in this authenticated document; only this
  // captured JavaScript waitlist control can act. Never activate a pay control.
  delete globalThis.__privateWaitlist;
  Reflect.apply(HTMLElement.prototype.click,button,[]);
  return {status:'outcome_unknown',action:'waitlist_only',capabilities};
}`;

type Observation = Pick<PrivateWaitlistResult, "status" | "action" | "capabilities">;
function observation(value: unknown): Observation {
  if (!value || typeof value !== "object") throw new Error("Private waitlist unavailable");
  const v = value as Observation;
  if (!["ready", "already_waitlisted", "class_mismatch", "payment_required", "policy_required", "unsupported", "outcome_unknown"].includes(v.status)
    || !["none", "waitlist_only", "payment", "policy", "unsupported"].includes(v.action) || !v.capabilities) throw new Error("Private waitlist unavailable");
  const keys = ["class_verified", "join_control_present", "join_control_enabled", "payment_control_present", "policy_required", "existing_credits_present", "no_payment_action", "confirmation_present"] as const;
  if (keys.some(k => typeof v.capabilities![k] !== "boolean")) throw new Error("Private waitlist unavailable");
  return { status: v.status, action: v.action,
    capabilities: Object.fromEntries(keys.map(k => [k, v.capabilities![k]])) as NonNullable<PrivateWaitlistResult["capabilities"]> };
}

type Journal = { fingerprint: string; operation_id: string; result?: PrivateWaitlistResult };
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
  .map(v => v.toString(16).padStart(2,"0")).join("");
const failure = (status: PrivateWaitlistResult["status"], reason: PrivateWaitlistResult["reason"]): PrivateWaitlistResult =>
  ({status,reason,login_attempted:status === "outcome_unknown",join_attempted:false,confirmation_observed:false,cleanup_confirmed:status !== "outcome_unknown",action:"none"});

export async function privateWaitlist(options: PrivateCheckoutOptions & Readonly<{ storage: Pick<DurableObjectStorage, "transaction"> }>): Promise<PrivateWaitlistResult> {
  let input: PrivateWaitlistInput;
  try { input = parsePrivateWaitlistInput(options.input); }
  catch { return failure("unavailable", "invalid_request"); }
  try { options.authorizeVaultAccess(options.context); }
  catch { return failure("unavailable", "not_authorized"); }
  if (input.operation === "join" && input.authorize_join !== true) return failure("unavailable", "not_authorized");
  const fingerprint = await digest(input);
  const operationKey = `private-waitlist:operation:${input.operation_id}`;
  // One Vault/class fence spans all UUIDs, including altered expectations.
  const parsedUrl = new URL(input.url);
  // Decode ordinary segment aliases, collapse redundant separators and trim a
  // trailing slash. Encoded separators/double encoding have router-dependent
  // meaning, so joining those paths is unsupported.
  if (input.operation === "join" && /%(?:2f|5c|25)/i.test(parsedUrl.pathname)) return failure("unsupported", "invalid_request");
  let classPath: string;
  try { classPath=decodeURIComponent(parsedUrl.pathname).normalize("NFC").replace(/\/+/g,"/").replace(/\/$/,"") || "/"; }
  catch { return failure("unavailable", "invalid_request"); }
  const fenceKey = `private-waitlist:class:${await digest([input.vault_id,parsedUrl.origin,classPath])}`;
  let claim: PrivateWaitlistResult | null;
  try { claim = await options.storage.transaction(async tx => {
    const old = await tx.get<Journal>(operationKey);
    if (old) return old.fingerprint !== fingerprint ? failure("conflict", "operation_mismatch")
      : old.result ?? failure("outcome_unknown", "operation_pending");
    const fence = input.operation === "join" ? await tx.get<Journal>(fenceKey) : undefined;
    if (fence) {
      const result = failure(fence.result ? "conflict" : "outcome_unknown", fence.result ? "operation_mismatch" : "operation_pending");
      await tx.put(operationKey,{fingerprint,operation_id:input.operation_id,result} satisfies Journal);
      return result;
    }
    const record: Journal = {fingerprint,operation_id:input.operation_id};
    await tx.put(operationKey,record);
    if (input.operation === "join") await tx.put(fenceKey,record);
    return null;
  }); } catch { return failure("outcome_unknown", "private_operation_failed"); }
  if (claim) return claim;
  let joinAttempted = false;
  let stage: NonNullable<PrivateWaitlistResult["failure_stage"]> = "login";
  let confirmed: PrivateWaitlistResult | undefined;
  const receipt = (current: Observation, attempted: boolean): PrivateWaitlistResult => ({...current,login_attempted:true,join_attempted:attempted,
    confirmation_observed:current.capabilities?.confirmation_present === true,cleanup_confirmed:true});
  let result: PrivateWaitlistResult;
  try {
    const value = await runPrivateCheckout<PrivateWaitlistResult>({...options,
      input:{vault_id:input.vault_id,url:input.url,username_selector:input.username_selector,password_selector:input.password_selector},
      afterLogin: async evaluate => {
        const read = async (mode: "inspect" | "capture" | "join" | "confirmation") => {
          stage=mode;
          const raw = await evaluate(WAITLIST,[input.url,input.expected,mode]);
          stage=`${mode}_result`;
          return observation(raw);
        };
        let current = await read("inspect");
        // Authentication can remove password fields before checkout details
        // finish rendering. Poll fixed read-only evidence, never the commit.
        for (let poll=0;poll<12 && ["class_mismatch","unsupported"].includes(current.status);poll++) {
          await new Promise(resolve=>setTimeout(resolve,250));
          current = await read("inspect");
        }
        if (input.operation === "inspect" || current.status !== "ready") return receipt(current,false);
        current = await read("capture");
        if (current.status !== "ready") return receipt(current,false);
        // Claim was durably written before credentials or controls were touched.
        // Mark uncertain before issuing the single commit call; never retry it.
        joinAttempted = true;
        current = await read("join");
        if (current.status !== "outcome_unknown") { joinAttempted=false; return receipt(current,false); }
        for (let poll=0;poll<20;poll++) {
          await new Promise(resolve=>setTimeout(resolve,250));
          current = await read("confirmation");
          if (current.status === "already_waitlisted") { confirmed=receipt({...current,status:"joined"},true); return confirmed; }
        }
        return receipt({...current,status:"outcome_unknown"},true);
      }});
    if ("join_attempted" in value) result=value;
    else if (confirmed) result={...confirmed,reason:"cleanup_unconfirmed",cleanup_confirmed:false};
    else result = {status:value.status === "inspected" ? "unsupported" : value.status,
      reason:value.reason === "cleanup_unconfirmed" ? "cleanup_unconfirmed" : "private_operation_failed",
      login_failure_stage:value.failure_stage,login_attempted:value.login_attempted,join_attempted:joinAttempted,confirmation_observed:false,cleanup_confirmed:value.reason !== "cleanup_unconfirmed",action:"none"};
  } catch { result = {status:"outcome_unknown",reason:"private_operation_failed",login_attempted:true,join_attempted:joinAttempted,confirmation_observed:confirmed !== undefined,cleanup_confirmed:false,action:"none"}; }
  if (result.reason === "private_operation_failed") result={...result,failure_stage:stage};
  try {
    await options.storage.transaction(async tx => {
      const old = await tx.get<Journal>(operationKey);
      const fence = input.operation === "join" ? await tx.get<Journal>(fenceKey) : undefined;
      if (old?.fingerprint !== fingerprint || input.operation === "join" && fence?.operation_id !== input.operation_id) throw new Error("Private operation journal changed");
      const record: Journal = {fingerprint,operation_id:input.operation_id,result};
      await tx.put(operationKey,record);
      // Uncertainty fences all future UUIDs. A confirmed join is also permanent.
      if (input.operation === "join") {
        if (result.status === "outcome_unknown" || result.join_attempted || result.status === "already_waitlisted") await tx.put(fenceKey,record);
        else await tx.delete(fenceKey);
      }
    });
  } catch { return {...result,status:"outcome_unknown",reason:"private_operation_failed"}; }
  return result;
}
