// Narrow adapter-private seam; no private runtime objects enter public DTOs.
import { CLOUDFLARE_SESSION_RESERVATION, observeAgentRelease } from '../../nanocodex/internal.mjs';
export function stripParentReservation(options) {
  Reflect.deleteProperty(options, CLOUDFLARE_SESSION_RESERVATION);
  return options;
}
export function observeClaudeRelease(agent, listener) { return observeAgentRelease(agent, listener); }
