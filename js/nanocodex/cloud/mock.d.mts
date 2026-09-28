import type { Transport } from "./Transport.mjs";

/**
 * In-memory Nanocodex Connect API for tests and demos. Requires the optional
 * `ox` peer dependency, which computes the EIP-191 access-key witness.
 */
export const MOCK_ACCOUNT_ADDRESS: `0x${string}`;
export const MOCK_MACHINE_USD_ADDRESS: `0x${string}`;

export function mock(options?: Readonly<{
  accountAddress?: `0x${string}` | undefined;
  appName?: string | undefined;
  appOrigin?: string | undefined;
  key?: string | undefined;
  machineUsdAddress?: `0x${string}` | undefined;
  name?: string | undefined;
}>): Transport<"mock">;
