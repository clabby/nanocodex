"use client";

import { useState, type ReactNode } from "react";
import { projectToolOutput, type ToolActivity } from "nanocodex-react/agent";
import { ChevronRight } from "lucide-react";
import { GeneratedOutputView } from "./GeneratedOutputView.js";
import { parseJson, readableToolResult } from "./toolModel.js";
import { StatusIcon, ToolRow } from "./ToolActivityView.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Identify the CUA server, including persisted machine aliases and dispatchers. */
export function isComputerTool(tool: ToolActivity): boolean {
  const metadata = record(tool.metadata);
  const input = record(parseJson(tool.input ?? tool.arguments));
  const name = metadata.tool_name ?? metadata.toolName ?? tool.name;
  const target = name === "MCPExecute" || name === "ToolExecute" ? input.name : name;
  return typeof target === "string" && /^(?:mcp__cua_repl__|(?:mcp\.)?cua_repl\.)/.test(target);
}

export function hasComputerActivity(tool: ToolActivity): boolean {
  return isComputerTool(tool) || tool.children.some(hasComputerActivity);
}

export function computerToolMedia(tool: ToolActivity) {
  return tool.generatedOutput ?? projectToolOutput(tool.images?.map(image_url => ({ type: "input_image", image_url })),
    parseJson(tool.output ?? tool.result));
}

export function computerToolFailed(tool: ToolActivity): boolean {
  return tool.status === "failed" || record(parseJson(tool.output ?? tool.result)).isError === true;
}

function preview(tool: ToolActivity) {
  const input = record(parseJson(tool.input ?? tool.arguments));
  const args = record(input.arguments ?? input);
  const title = typeof args.title === "string" && args.title.trim() ? args.title : "Computer action";
  const failed = computerToolFailed(tool);
  const value = failed ? readableToolResult(tool) : undefined;
  const error = value?.type === "text" ? value.text.replace(/^Script error:\s*/, "").split("\n").find(line => line.trim()) : undefined;
  return { tool, title, failed, error, images: computerToolMedia(tool).filter(item => item.kind === "image") };
}

/** Group siblings only: Code Mode parents and intervening tools retain their position. */
export function ComputerToolRows({ tools }: { tools: readonly ToolActivity[] }) {
  const rows: ReactNode[] = [];
  for (let i = 0; i < tools.length;) {
    const tool = tools[i]!;
    if (!isComputerTool(tool)) { rows.push(<ToolRow key={tool.callId} tool={tool} />); i++; continue; }
    const adjacent = [tool];
    while (++i < tools.length && isComputerTool(tools[i]!)) adjacent.push(tools[i]!);
    rows.push(<ComputerActivity key={tool.callId} tools={adjacent} />);
  }
  return <>{rows}</>;
}

export function ComputerActivity({ tools, children }: { tools: readonly ToolActivity[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const calls = tools.map(preview);
  const active = [...calls].reverse().find(call => call.tool.status === "running");
  const failures = calls.filter(call => call.failed).length;
  const cancelled = calls.filter(call => call.tool.status === "cancelled").length;
  const status = active ? "running" : failures ? "failed" : cancelled ? "cancelled" : "completed";
  const selected = active ? [active] : calls.map((call, index) => ({ call, index }))
    .sort((a, b) => Number(b.call.failed) - Number(a.call.failed) || Number(Boolean(b.call.images.length)) - Number(Boolean(a.call.images.length)) || b.index - a.index)
    .slice(0, calls.length > 3 ? 2 : 3).sort((a, b) => a.index - b.index).map(item => item.call);
  return <div className={`agent-computer-activity is-${status}`}>
    <details className="agent-work-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <StatusIcon status={status} />
        <span className="agent-work-heading"><strong>{active ? "Using computer" : "Used computer"}</strong>
          <span>{tools.length} {tools.length === 1 ? "action" : "actions"}</span>
          {failures ? <span className="is-failed">{failures} failed</span> : null}
          {cancelled ? <span>{cancelled} cancelled</span> : null}
        </span>
        <ChevronRight className="agent-tool-chevron" aria-hidden="true" />
      </summary>
      {open ? <div className="agent-work-body">{children ?? tools.map(tool => <ToolRow key={tool.callId} tool={tool} />)}
      </div> : null}
    </details>
    {!open ? <div className="agent-computer-previews">{selected.map(call => <div key={call.tool.callId}>
      <p className={call.failed ? "is-failed" : undefined}>{call.failed && call.error ? <>Failed: <span className="agent-computer-failure-title">{call.title} — </span>{call.error}</> : <>{call.failed ? "Failed: " : call.tool.status === "cancelled" ? "Cancelled: " : call.images.length ? "Captured screenshot · " : ""}{call.title}</>}</p>
      <GeneratedOutputView items={call.images.slice(-1)} />
    </div>)}{calls.length > selected.length ? <p>{calls.length - selected.length} more actions · Expand for details</p> : null}</div> : null}
  </div>;
}
