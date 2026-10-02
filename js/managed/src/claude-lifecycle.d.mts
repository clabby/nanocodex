import type { Agent } from '../../nanocodex/runtime/claude.mjs';
export function stripParentReservation<T extends object>(options: T): T;
export function observeClaudeRelease(agent: Pick<Agent, "uid" | "sessionId">, listener: () => void): () => void;
