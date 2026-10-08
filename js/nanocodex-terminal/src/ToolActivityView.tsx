"use client";

import { memo, useEffect, useState, type ReactNode } from "react";
import type { ToolActivity } from "nanocodex-react/agent";
import {
  Ban, Bot, Brain, Check, ChevronRight, CodeXml, Database, FileDiff as FileDiffIcon, FilePen, FilePlus,
  FileText, Globe, Image, KeyRound, LoaderCircle, Mail, Plug, Search, SquareTerminal, Wrench, X, ExternalLink,
} from "lucide-react";
import { boundedToolDetail, presentTool } from "./toolPresentation.js";
import {
  modelTool, readableToolInput, readableToolResult, type FileDiff, type ReadableValue, type ToolKind, type ToolModel,
} from "./toolModel.js";

/** One shared clock; only mounted live elements subscribe, and it stops when idle. */
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    listeners.add(setNow);
    timer ??= setInterval(() => { const value = Date.now(); listeners.forEach(listener => listener(value)); }, 1000);
    return () => {
      listeners.delete(setNow);
      if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
    };
  }, [active]);
  return now;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const KIND_ICONS: Record<ToolKind, typeof Wrench> = {
  command: SquareTerminal, code: CodeXml, read: FileText, write: FilePlus, edit: FilePen, patch: FileDiffIcon,
  search: Search, browser: Globe, image: Image, preview: ExternalLink, subagent: Bot, mcp: Plug,
  account: KeyRound, message: Mail, memory: Database, generic: Wrench,
};

export function KindIcon({ kind }: { kind: ToolKind | "thinking" }) {
  const Icon = kind === "thinking" ? Brain : KIND_ICONS[kind];
  return <Icon className="agent-tool-kind-icon" aria-hidden="true" />;
}

export function StatusIcon({ status }: { status: ToolActivity["status"] | "thinking" }) {
  if (status === "running" || status === "thinking") return <LoaderCircle className="agent-tool-status-icon is-running" aria-hidden="true" />;
  if (status === "completed") return <Check className="agent-tool-status-icon is-completed" aria-hidden="true" />;
  if (status === "cancelled") return <Ban className="agent-tool-status-icon is-cancelled" aria-hidden="true" />;
  return <X className="agent-tool-status-icon is-failed" aria-hidden="true" />;
}

const STATUS_TEXT: Record<ToolActivity["status"], string> = {
  running: "Running", completed: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};

export function DiffView({ diff }: { diff: FileDiff }) {
  const operation = diff.operation === "add" ? "Created" : diff.operation === "delete" ? "Deleted"
    : diff.operation === "move" ? `Moved to ${diff.movedTo}` : "Modified";
  return <figure className="agent-tool-diff">
    <figcaption>
      <span className="agent-tool-diff-path" title={diff.path}>{diff.path}</span>
      <span className="agent-tool-diff-meta">{operation}</span>
      <DiffStat added={diff.added} removed={diff.removed} />
    </figcaption>
    {diff.lines.length ? <div className="agent-tool-diff-lines" role="table" aria-label={`Changes to ${diff.path}`}>
      {diff.lines.slice(0, 600).map((line, index) => line.kind === "gap"
        ? <div className="agent-tool-diff-gap" role="row" key={index}><span role="cell">{line.text || "⋯"}</span></div>
        : <div className={`agent-tool-diff-line is-${line.kind}`} role="row" key={index}>
          <span className="agent-tool-diff-sign" role="cell" aria-label={line.kind === "add" ? "Added" : line.kind === "remove" ? "Removed" : "Unchanged"}>
            {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
          </span>
          <code role="cell">{line.text || " "}</code>
        </div>)}
      {diff.lines.length > 600 ? <div className="agent-tool-diff-gap" role="row"><span role="cell">{diff.lines.length - 600} more lines</span></div> : null}
    </div> : <p className="agent-tool-empty">No line changes in preview.</p>}
  </figure>;
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return <span className="agent-tool-diffstat" aria-label={`${added} lines added, ${removed} lines removed`}>
    {added ? <span className="is-add">+{added}</span> : null}
    {removed ? <span className="is-remove">−{removed}</span> : null}
  </span>;
}

function CodeBlock({ text, label, numbered = false, tone }: { text: string; label?: string; numbered?: boolean; tone?: "error" }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return <section className={`agent-tool-block${tone ? ` is-${tone}` : ""}`}>
    {label ? <h4>{label}</h4> : null}
    <pre tabIndex={0}>{numbered
      ? lines.map((line, index) => <span className="agent-tool-numbered" key={index}><span aria-hidden="true">{index + 1}</span>{line || " "}{"\n"}</span>)
      : text}</pre>
  </section>;
}

/** Payload as prose, lists, and labeled fields; never braces or quoted keys. */
export function ReadableView({ value }: { value: ReadableValue }): ReactNode {
  if (value.type === "text") return value.multiline
    ? <pre className="agent-tool-readable-text" tabIndex={0}>{value.text}</pre>
    : <span className="agent-tool-readable-inline">{value.text}</span>;
  if (value.type === "list") return <ol className="agent-tool-readable-list">
    {value.items.map((item, index) => <li key={index}><ReadableView value={item} /></li>)}
    {value.more ? <li className="agent-tool-empty">{value.more} more</li> : null}
  </ol>;
  return <dl className="agent-tool-fields">
    {value.fields.map((field, index) => <div key={`${field.label}:${index}`}
      className={field.value.type === "text" && !field.value.multiline ? "is-inline" : "is-block"}>
      <dt>{field.label}</dt>
      <dd><ReadableView value={field.value} /></dd>
    </div>)}
  </dl>;
}

function ReadableSection({ label, value, tone }: { label: string; value: ReadableValue; tone?: "error" }) {
  return <section className={`agent-tool-block agent-tool-readable${tone ? ` is-${tone}` : ""}`}>
    <h4>{label}</h4>
    <ReadableView value={value} />
  </section>;
}

/** Raw protocol payloads stay available, but only behind an explicit, lazily rendered disclosure. */
function ProtocolDetails({ tool, source }: { tool: ToolActivity; source?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const input = tool.input ?? tool.arguments;
  const output = tool.output ?? tool.result;
  return <details className="agent-tool-protocol" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight className="agent-tool-chevron" aria-hidden="true" />Details</summary>
    {open ? <div className="agent-tool-protocol-body">
      <p className="agent-tool-wire"><span>Tool</span> <code>{tool.name}</code>{source ? <> · {source}</> : null}</p>
      {input ? <CodeBlock label="Raw input" text={boundedToolDetail(input, 200)} /> : null}
      {output ? <CodeBlock label="Raw output" text={boundedToolDetail(output, 200)} /> : null}
    </div> : null}
  </details>;
}

function ToolBody({ tool, model }: { tool: ToolActivity; model: ToolModel }) {
  const failed = tool.status === "failed" || tool.status === "cancelled";
  const sections: ReactNode[] = [];
  const result = () => {
    const value = readableToolResult(tool);
    if (value) return <ReadableSection key="result" label={failed ? "Error" : "Result"} value={value} {...(failed ? { tone: "error" as const } : {})} />;
    return tool.status === "running" ? <p key="waiting" className="agent-tool-empty">Waiting for result…</p> : null;
  };
  const request = (label = "Request") => {
    const value = readableToolInput(tool);
    return value ? <ReadableSection key="request" label={label} value={value} /> : null;
  };
  if (model.kind === "command" && model.command) {
    const { command, output, stderr, cwd } = model.command;
    sections.push(<section key="terminal" className="agent-tool-terminal" aria-label="Command and output">
      <div className="agent-tool-terminal-command">
        {cwd ? <span className="agent-tool-terminal-cwd">{cwd}</span> : null}
        <code><span aria-hidden="true">$ </span>{command}</code>
      </div>
      {output ? <pre tabIndex={0}>{output}</pre> : null}
      {stderr ? <pre tabIndex={0} className="is-stderr" aria-label="Standard error">{stderr}</pre> : null}
      {!output && !stderr ? <p className="agent-tool-empty">{tool.status === "running" ? "Waiting for output…" : failed && model.error ? model.error : "No output"}</p> : null}
      {model.exitCode !== undefined ? <p className={`agent-tool-terminal-exit${model.exitCode ? " is-failed" : ""}`}>Exit code {model.exitCode}</p> : null}
    </section>);
  } else if (model.diffs?.length) {
    model.diffs.forEach((diff, index) => sections.push(<DiffView key={`${diff.path}:${index}`} diff={diff} />));
    if (failed) sections.push(result());
  } else if (model.kind === "read") {
    sections.push(model.file?.content
      ? <CodeBlock key="file" label={model.file.range ? `${model.file.path} · ${model.file.range}` : model.file.path} text={model.file.content} />
      : result());
  } else if (model.kind === "code") {
    if (model.code) sections.push(<CodeBlock key="code" label="Code" text={model.code} numbered />);
    if (!tool.children.length || failed) sections.push(result());
  } else if (model.kind === "subagent") {
    const input = presentTool(tool);
    if (input.subject) sections.push(<ReadableSection key="task" label="Request" value={{ type: "text", text: input.subject, multiline: true }} />);
    else sections.push(request());
    sections.push(result());
  } else {
    sections.push(request());
    sections.push(result());
  }
  return <div className="agent-tool-body">
    {sections}
    <ProtocolDetails tool={tool} source={model.source} />
  </div>;
}

/**
 * Compact Amp-style activity row: one summary line (status, icon, name, target,
 * duration). Details, nested calls and raw payloads render only when expanded;
 * failures stay collapsed behind a red status marker.
 */
export const ToolRow = memo(function ToolRow({ tool }: { tool: ToolActivity }) {
  const model = modelTool(tool);
  const [open, setOpen] = useState(false);
  const running = tool.status === "running";
  const now = useNow(running);
  const [seenAt] = useState(() => Date.now());
  const elapsed = running ? formatElapsed(now - Math.min(tool.startedAtMs ?? seenAt, now)) : model.duration;
  const added = model.diffs?.reduce((total, diff) => total + diff.added, 0) ?? 0;
  const removed = model.diffs?.reduce((total, diff) => total + diff.removed, 0) ?? 0;
  const target = model.kind === "command" && model.target ? `$ ${model.target}` : model.target;
  const nested = tool.children.length;
  return <div className={`agent-tool-row is-${tool.status}`} data-tool-kind={model.kind} data-tool-status={tool.status}>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary title={model.error}>
        <StatusIcon status={tool.status} />
        <KindIcon kind={model.kind} />
        <span className="agent-tool-title">
          {model.label ? <strong>{model.label}</strong> : null}
          {target ? <code className="agent-tool-target" title={model.target}>{target}</code> : null}
          {model.detail ? <span className="agent-tool-detail">{model.detail}</span> : null}
        </span>
        <span className="agent-tool-meta">
          <DiffStat added={added} removed={removed} />
          {model.exitCode ? <span className="agent-tool-exit">exit {model.exitCode}</span> : null}
          {nested && !open ? <span className="agent-tool-count">{nested} {nested === 1 ? "call" : "calls"}</span> : null}
          {model.source ? <span className="agent-tool-source">{model.source}</span> : null}
          <span className="agent-terminal-sr-only">{STATUS_TEXT[tool.status]}{model.error ? `: ${model.error}` : ""}</span>
          {elapsed ? <span className="agent-tool-time" aria-hidden={running ? "true" : undefined}>{elapsed}</span> : null}
          <ChevronRight className="agent-tool-chevron" aria-hidden="true" />
        </span>
      </summary>
      {open ? <>
        <ToolBody tool={tool} model={model} />
        {nested ? <div className="agent-tool-children">
          {tool.children.map(child => <ToolRow key={child.callId} tool={child} />)}
        </div> : null}
      </> : null}
    </details>
  </div>;
});
