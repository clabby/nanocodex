// Narrow adapter-private seam; no private runtime objects enter public DTOs.
import { observeAgentRelease } from '../../nanocodex/internal.mjs';
export function observeClaudeRelease(agent, listener) { return observeAgentRelease(agent, listener); }
