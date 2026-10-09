import type { Agent } from '../../nanocodex/runtime/claude.mjs';
export function observeClaudeRelease(agent: Pick<Agent, "uid" | "sessionId">, listener: () => void): () => void;
