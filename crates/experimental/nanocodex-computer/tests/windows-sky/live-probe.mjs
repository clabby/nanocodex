// Legacy Windows receipts may launch official Codex. Do not run them merely to
// diagnose no-Codex support. Native proof requires a verified helper contract
// and an online Windows Hand; cross-platform framing fixtures are not proof.
import { WINDOWS_NATIVE_CONTRACT_BLOCKER } from '../../src/windows_sky_host.mjs';
throw new Error(WINDOWS_NATIVE_CONTRACT_BLOCKER);
