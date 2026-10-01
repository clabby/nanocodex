import { ClaudeSubscription } from '../worker/index.mjs';
import type {
  ClaudeSubscriptionOptions,
  ClaudeSubscriptionHandle,
  ClaudeSubscriptionStatus,
} from '../index.mjs';

declare const module: WebAssembly.Module;
const options: ClaudeSubscriptionOptions = {
  id: 'synthetic-private-account',
  module,
  store: {
    async load(id) {
      const account: string = id;
      void account;
      return { revision: '0' };
    },
    async compareAndSwap(id, input) {
      const account: string = id;
      const revision: string = input.expectedRevision;
      const opaquePrivateState: string = input.payload;
      void account; void revision; void opaquePrivateState;
      return { status: 'committed', revision: '1' };
    },
  },
};
const opened: Promise<ClaudeSubscriptionHandle> = ClaudeSubscription.open(options);
opened.then(async subscription => {
  const login = await subscription.startLogin();
  const url: string = login.authorization_url;
  const milliseconds: number = login.expires_at;
  void url; void milliseconds;
  const status: ClaudeSubscriptionStatus = await subscription.status();
  if (status.state === 'authenticated') {
    const account: string = status.account_id;
    const organization: string = status.organization_id;
    void account; void organization;
  }
  // Safe status cannot expose access/refresh tokens or pending PKCE material.
  // @ts-expect-error Tokens are private host state, not connection metadata.
  status.access_token;
  // @ts-expect-error Pending OAuth verifier is never public status.
  status.code_verifier;
  await subscription.logout();
  subscription.dispose();
});
// Worker initialization always requires an explicit precompiled module.
// @ts-expect-error A Worker cannot fetch/compile an implicit WASM module.
ClaudeSubscription.open({ id: options.id, store: options.store });
// CAS revisions are lossless strings, not unsafe JS numeric u64 values.
// @ts-expect-error A numeric revision violates the persistent host contract.
options.store.compareAndSwap(options.id, { expectedRevision: 1, payload: '{}' });
