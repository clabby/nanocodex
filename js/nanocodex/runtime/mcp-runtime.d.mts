import type { McpServers, ToolContext } from '../types.mjs';
export function createMcpRuntime(configuration: McpServers, options?: Record<string, unknown>): Promise<{
  search(input: Record<string, unknown>): unknown;
  resolve(name: string): { handler(input: unknown, context: ToolContext): Promise<unknown> } | undefined;
  settled(): Promise<void>;
  close(): Promise<void>;
}>;
