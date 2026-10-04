import { isBrowserVaultOrigin, type BrowserVaultIdentity, type PrivateBrowserCdp } from "./browser-vault";

/** Metadata only. A request ID is an isolation identity, never a Vault reference. */
export type BrowserLoginRequest = { operationId: string; url: string; allowedOrigins: string[]; deferInput?: boolean };
export function parseBrowserLoginRequest(input: unknown): BrowserLoginRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid browser login request");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["operation_id", "url", "allowed_origins", "defer_input"].includes(key))
    || typeof value.operation_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.operation_id)
    || (value.defer_input !== undefined && typeof value.defer_input !== "boolean")
    || typeof value.url !== "string" || value.url.length > 4096) throw new Error("Invalid browser login request");
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error("Browser login requires HTTPS"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Browser login requires HTTPS");
  const origins = value.allowed_origins ?? [url.origin];
  if (!Array.isArray(origins) || !origins.length || origins.length > 8 || !origins.every(isBrowserVaultOrigin)
    || !origins.includes(url.origin) || new Set(origins).size !== origins.length) throw new Error("Approve an exact bounded list of HTTPS sites including the initial site");
  return {operationId:value.operation_id, url:url.href, allowedOrigins:[...origins].sort(),...(value.defer_input !== undefined ? {deferInput:value.defer_input} : {})};
}

/** Check every loaded frame before input or private observation. Page content cannot
 * expand this list. about:blank/srcdoc inherit their parent origin. */
export async function browserLoginIdentity(cdp: Pick<PrivateBrowserCdp, "send" | "attachTarget">,
  identity: BrowserVaultIdentity, allowedOrigins: readonly string[]): Promise<BrowserVaultIdentity> {
  const allowed = (value: unknown, inherited?: string): string => {
    if (typeof value !== "string") throw new Error("Private login site unavailable");
    if (inherited && (value === "about:blank" || value === "about:srcdoc")) return inherited;
    const url = new URL(value);
    if (!allowedOrigins.includes(url.origin) || url.protocol !== "https:" || url.username || url.password) throw new Error("Private login reached an unapproved site");
    return url.origin;
  };
  const {targetInfo} = await cdp.send("Target.getTargetInfo", {targetId:identity.target_id});
  if (targetInfo?.type !== "page" || targetInfo.targetId !== identity.target_id) throw new Error("Private login target changed");
  const origin = allowed(targetInfo.url);
  const attached = await cdp.attachTarget(identity.target_id);
  const {frameTree} = await cdp.send("Page.getFrameTree", {}, attached.sessionId);
  let count = 0;
  const visit = (tree: any, parent?: string) => {
    if (++count > 128 || !tree?.frame) throw new Error("Private login frame unavailable");
    const current = allowed(tree.frame.url, parent);
    for (const child of tree.childFrames ?? []) visit(child, current);
    return current;
  };
  if (visit(frameTree) !== origin) throw new Error("Private login document changed");
  return {...identity,expected_origin:origin};
}
