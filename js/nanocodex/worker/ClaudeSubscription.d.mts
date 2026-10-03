/** Safe public account status; never contains provider tokens or pending PKCE state. */
export type Status = { state: 'signed_out' | 'expired' | 'exchange_uncertain' | 'validating' | 'account_on_hold' } | { state: 'pending'; expires_at: number } | { state: 'authenticated'; expires_at: number; account_id: string; organization_id: string };
export interface PrivateCredential { readonly kind: 'claude'; readonly headers: Readonly<Record<string,string>>; readonly revision: string; }
export interface Subscription {
  readonly id: string;
  startLogin(): Promise<{ authorization_url: string; expires_at: number }>;
  completeLogin(privateCode: string): Promise<Status>;
  status(): Promise<Status>;
  /** Host-private only. Never put this result in browser responses, tools, logs, or model context. */
  credential(): Promise<PrivateCredential>;
  recover(rejectedHeaders: Readonly<Record<string,string>>): Promise<boolean>;
  logout(): Promise<void>;
  dispose(): void;
}
export interface Options {
  id: string;
  module: WebAssembly.Module;
  store: {
    load(id: string): Promise<{revision: string; payload?: string}>;
    compareAndSwap(id: string, input: {expectedRevision: string; payload: string}): Promise<{status:'committed';revision:string} | {status:'conflict';actualRevision:string}>;
  };
  fetch?: typeof globalThis.fetch;
}
export function open(options: Options): Promise<Subscription>;
