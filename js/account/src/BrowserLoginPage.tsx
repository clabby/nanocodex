import { useEffect, useRef, useState } from "react";
import { AccountChooser } from "nanocodex-connect-ui/AccountChooser";
import type { ToolActivity } from "nanocodex-react/agent";
import { useAccountSession } from "./AccountSession";
import { BrowserTakeoverCard } from "./BrowserTakeoverCard";
import { decodeVaultIntake, type VaultIntake } from "./vaultIntake";
import { pathForAgent } from "./navigation";

/** An account-authenticated URL, not a bearer link or a browser provider URL. */
export function BrowserLoginPage({url}: {url: URL}) {
  const account=useAccountSession(),agent=url.searchParams.get("agent")??"",request=url.searchParams.get("request")??"";
  const valid=/^[A-Za-z0-9_-]{1,128}$/.test(agent)&&/^[0-9a-f-]{36}$/i.test(request);
  const [intake,setIntake]=useState<VaultIntake>(),[error,setError]=useState(""),[status,setStatus]=useState("");
  const receipt=useRef<string | undefined>(undefined),sending=useRef(false);
  useEffect(()=>{
    setIntake(undefined);setError("");setStatus("");receipt.current=undefined;
    if(!valid || !account.account?.persistent)return;
    const controller=new AbortController();
    void fetch(`/v1/agents/${agent}/browser-vault/takeover`,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",signal:controller.signal,
      headers:{"content-type":"application/json"},body:JSON.stringify({challenge_id:request,action:"describe"})})
      .then(async response=>{if(!response.ok){await response.body?.cancel();throw Error();}return response.json();})
      .then(value=>{
        const decoded=decodeVaultIntake({name:"request_browser_login",status:"completed",output:JSON.stringify(value)} as ToolActivity);
        if(!decoded || decoded.agent_id!==agent || decoded.request_id!==request)throw Error();
        if(!controller.signal.aborted)setIntake(decoded);
      }).catch(()=>{if(!controller.signal.aborted)setError("This private sign-in is unavailable or expired. Return to the conversation to request a fresh login.");});
    return ()=>controller.abort();
  },[account.account?.id,account.account?.persistent,agent,request,valid]);
  async function resume(value:string) {
    if(sending.current)return;
    // Validate the fixed receipt before allowing it into conversation transport.
    let parsed: {type?:unknown;status?:unknown;request_id?:unknown};
    try{parsed=JSON.parse(value);}catch{return;}
    if(Object.keys(parsed).length!==3 || parsed.type!=="browser_login_receipt" || parsed.request_id!==request || !["finished","cancelled"].includes(String(parsed.status)))return;
    receipt.current=value;sending.current=true;setStatus("Returning to your conversation…");setError("");
    try{
      const response=await fetch(`/v1/agents/${agent}/turns`,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",headers:{"content-type":"application/json"},
        body:JSON.stringify({id:`browser-login-${request}-${parsed.status}`,input:value})});
      if(!response.ok){await response.body?.cancel();throw Error();}
      await response.body?.cancel();setStatus(parsed.status==="finished"?"The agent is checking your sign-in and continuing the task.":"Sign-in cancelled. The agent has been notified.");
    }catch{setError("Could not confirm delivery to the conversation. Retry uses the same receipt and will not repeat your login.");}
    finally{sending.current=false;}
  }
  return <main style={{maxWidth:640,margin:"auto",padding:24}}>
    <h1>Private sign-in</h1>
    {!valid?<p>Invalid sign-in link.</p>:account.status==="checking"?<p role="status">Checking your Nanocodex account…</p>:!account.account?.persistent?
      <AccountChooser description="Sign in to your Nanocodex account to open this private browser. The link alone does not grant access." disabled={account.operation!==null} failure={account.error} onChooseAccount={selection=>void account.chooseAccount(selection)}/>:
      <>{intake?<BrowserTakeoverCard key={`${account.account.id}:${request}`} intake={intake} authenticated onReceipt={value=>void resume(value)}/>:!error?<p role="status">Opening private sign-in…</p>:null}
      {status?<p role="status">{status}</p>:null}{error?<p role="alert">{error}</p>:null}
      {error&&receipt.current?<button onClick={()=>void resume(receipt.current!)}>Retry receipt delivery</button>:null}
      <p><a href={pathForAgent(agent)}>Return to conversation</a></p></>}
  </main>;
}
