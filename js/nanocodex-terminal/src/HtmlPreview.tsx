import { memo, useEffect, useMemo, useRef, useState } from "react";
import { htmlPreviewDocument } from "./htmlDocument.js";
import { RichMarkdown } from "./RichMarkdown.js";

const MIN_HEIGHT = 48;
const MAX_HEIGHT = 1200;
const INITIAL_HEIGHT = 160;

/** Inline HTML card: an opaque-origin sandbox (scripts, no same-origin, no
 * popups, forms or top navigation) loaded only near the viewport. */
export const HtmlPreview = memo(function HtmlPreview({ html, name = "HTML preview" }: { html: string; name?: string }) {
  const card = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [near, setNear] = useState(false);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [sized, setSized] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const document = useMemo(() => near && typeof DOMParser !== "undefined" ? htmlPreviewDocument(html) : "", [html, near]);

  useEffect(() => {
    const element = card.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || source || blocked) return;
    const receive = (event: MessageEvent) => {
      // Only the original srcdoc document of this exact frame may talk to us.
      if (!frame.current || event.source !== frame.current.contentWindow || loads.current > 1) return;
      const message = event.data as { jsonrpc?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
      if (message.method === "ui/notifications/size-changed") {
        const value = message.params?.height;
        if (typeof value === "number" && Number.isFinite(value)) {
          setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value))));
          setSized(true);
        }
      } else if (message.method === "ui/open-link") {
        const url = safeLink(message.params?.url);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      } else if (message.method === "ui/notifications/escape") setExpanded(false);
    };
    window.addEventListener("message", receive);
    const fallback = setTimeout(() => setSized(true), 2000);
    return () => { window.removeEventListener("message", receive); clearTimeout(fallback); };
  }, [document, source, blocked, revision]);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  function reload() {
    loads.current = 0;
    setBlocked(false); setSized(false); setHeight(INITIAL_HEIGHT); setNear(true); setSource(false);
    setRevision(value => value + 1);
  }
  function download() {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = /\.html?$/i.test(name) ? name : "preview.html";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const fence = "`".repeat(Math.max(3, ...Array.from(html.matchAll(/`{3,}/g), match => match[0].length + 1)));
  return <figure ref={card} className={`agent-html-preview${expanded ? " is-expanded" : ""}`} aria-label={name}>
    <figcaption className="agent-html-preview-header">
      <span className="agent-html-preview-name" title={name}>{name}</span>
      <span className="agent-html-preview-actions">
        <span role="group" aria-label="View">
          <button type="button" aria-pressed={!source} onClick={() => { setSource(false); setNear(true); }}>Preview</button>
          <button type="button" aria-pressed={source} onClick={() => { loads.current = 0; setSource(true); }}>Source</button>
        </span>
        <button type="button" onClick={reload}>Reload</button>
        <button type="button" aria-pressed={expanded} onClick={() => { setNear(true); setExpanded(value => !value); }}>{expanded ? "Collapse" : "Expand"}</button>
        <button type="button" onClick={download}>Download</button>
      </span>
    </figcaption>
    {source ? <div className="agent-html-preview-source"><RichMarkdown htmlPreviews={false}>{`${fence}html\n${html}\n${fence}`}</RichMarkdown></div>
      : blocked ? <p className="agent-html-preview-notice" role="status">The preview tried to navigate away and was stopped. Reload to run it again.</p>
        : document ? <iframe key={revision} ref={frame} title={name} srcDoc={document}
          sandbox="allow-scripts" referrerPolicy="no-referrer" allow=""
          className={sized ? undefined : "is-sizing"}
          style={expanded ? undefined : { height }}
          onLoad={() => { loads.current += 1; if (loads.current > 1) setBlocked(true); }} />
          : <p className="agent-html-preview-notice" style={{ height: INITIAL_HEIGHT }}>Preview loads when visible</p>}
  </figure>;
});

function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
